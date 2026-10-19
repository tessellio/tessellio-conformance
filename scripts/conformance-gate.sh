#!/usr/bin/env bash
# The Tessellio conformance gate.
#
# The corpus is the codec's shared, executable description of what it
# promises. This gate is what keeps it honest:
#
#   1. the static checker validates the vectors and the corpus: the schema,
#      the codec's identity, the hand-derived vectors' every byte, and the
#      corpus's completeness;
#   2. the reference implementation regenerates the corpus and the gate
#      requires it to be byte-identical to the committed one;
#   3. the corpus consumer replays every case through the decoder and
#      requires the committed expectations to hold;
#   4. the consumer's "no corpus" marker is counted and required to be
#      zero, so a deleted or unreadable corpus cannot pass as a green run
#      that compared nothing;
#   5. the gate checks its own teeth: a mutation of the corpus must be
#      noticed.
#
# Usage:
#   scripts/conformance-gate.sh             # run it
#   scripts/conformance-gate.sh --update    # regenerate the corpus in place
#   scripts/conformance-gate.sh --self-test # check the checker
#
# The reference implementation is expected next to this repository as
# `../tessellio-core`; `TESSELLIO_CORE_DIR` overrides that.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORPUS_DIR="$REPO_ROOT"
CORE_DIR="${TESSELLIO_CORE_DIR:-$REPO_ROOT/../tessellio-core}"
LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/tessellio-conformance-XXXXXX")"
trap 'rm -rf "$LOGDIR"' EXIT

SCENARIO_COUNT_EXPECTED=72
VECTOR_COUNT_EXPECTED=5

UPDATE=0
SELFTEST=0
for argument in "$@"; do
    case "$argument" in
        --update) UPDATE=1 ;;
        --self-test) SELFTEST=1 ;;
        *) printf 'tessellio-conformance-gate: unknown argument %s\n' "$argument" >&2; exit 2 ;;
    esac
done

PASSES=0
FAILURES=0
SKIPPED=0

ok() {
    PASSES=$((PASSES + 1))
    printf '  ok    %s\n' "$1"
}

fail() {
    FAILURES=$((FAILURES + 1))
    printf '  FAIL  %s\n' "$1" >&2
    if [ $# -gt 1 ]; then
        printf '        %s\n' "$2" >&2
    fi
}

skip() {
    SKIPPED=$((SKIPPED + 1))
    printf '  skip  %s\n' "$1"
}

die() {
    printf 'tessellio-conformance-gate: %s\n' "$1" >&2
    exit 2
}

# ── the static checker ──────────────────────────────────────────────────────
#
# It is its own process, so its verdict lines are folded into this shell's
# ledger here: its FAIL lines are the gate's failures, and a static run that
# failed must not be able to exit 0.

static_check() {
    local log="$LOGDIR/static.log" rc=0
    node "$CORPUS_DIR/scripts/check-vectors.mjs" >"$log" 2>&1 || rc=$?
    cat "$log"

    local good bad
    good="$(grep -c '^ok ' "$log" || true)"
    bad="$(grep -c '^FAIL ' "$log" || true)"
    PASSES=$((PASSES + ${good:-0}))
    FAILURES=$((FAILURES + ${bad:-0}))

    if [ "$rc" = "2" ]; then
        die "the static checker could not run"
    fi
    if [ "$rc" != "0" ] && [ "${bad:-0}" = "0" ]; then
        fail "vectors: the static checker failed without a verdict"
    fi
}

# ── the reference implementation ────────────────────────────────────────────
#
# It regenerates the corpus, so a change to the codec that changes a byte
# of the wire format is a change the gate catches.

regenerate_corpus() { # outfile
    ( cd "$CORE_DIR" && TESSELLIO_CORPUS_OUT="$1" \
        cargo test -p tessellio-core --test codec_corpus_gen -- --nocapture )
}

check_corpus() {
    local scratch="$LOGDIR/corpus.json"
    if ! regenerate_corpus "$scratch" >"$LOGDIR/runner.log" 2>&1; then
        fail "corpus: reproducible" "the generator exited non-zero; its log follows"
        tail -20 "$LOGDIR/runner.log" >&2
        return
    fi

    local absent
    absent="$(grep -c 'tessellio-corpus: no corpus' "$LOGDIR/runner.log" || true)"
    if [ "$absent" != "0" ]; then
        fail "corpus: reproducible" \
            "the generator printed its no-corpus marker ${absent} time(s)"
        return
    fi

    local marker
    marker="$(grep -oE 'corpus: cases=[0-9]+ bytes=[0-9]+' "$LOGDIR/runner.log" | tail -1)"
    if [ -z "$marker" ]; then
        fail "corpus: reproducible" "the generator printed no summary line"
        return
    fi
    local cases
    cases="$(printf '%s' "$marker" | sed -E 's/.*cases=([0-9]+).*/\1/')"
    if [ "$cases" != "$SCENARIO_COUNT_EXPECTED" ]; then
        fail "corpus: case count" \
            "expected $SCENARIO_COUNT_EXPECTED, the generator produced $cases"
        return
    fi

    if [ "$UPDATE" = "1" ]; then
        cp "$scratch" "$CORPUS_DIR/corpus.json"
        ok "corpus: regenerated ($cases cases)"
        return
    fi

    if cmp -s "$scratch" "$CORPUS_DIR/corpus.json"; then
        ok "corpus: $cases cases byte-identical"
    else
        fail "corpus: reproducible" \
            "the regenerated corpus differs from the committed one (run with --update)"
    fi
}

# ── the consumer ────────────────────────────────────────────────────────────
#
# The consumer replays every case through the decoder. The Rust suite does
# it here, and the browser suite does it in its own package against the
# same committed file.

check_consumer() {
    if ! ( cd "$CORE_DIR" && cargo test -p tessellio-core --test codec_conformance -- --nocapture ) \
            >"$LOGDIR/consumer.log" 2>&1; then
        fail "corpus: consumed" "the Rust consumer failed; its log follows"
        tail -20 "$LOGDIR/consumer.log" >&2
        return
    fi
    local marker
    marker="$(grep -oE 'codec-conformance: vectors=[0-9]+ corpus=[0-9]+ consumed=[a-z]+' \
        "$LOGDIR/consumer.log" | tail -1)"
    if [ -z "$marker" ]; then
        fail "corpus: consumed" "the Rust consumer printed no summary line"
        return
    fi
    if ! printf '%s' "$marker" | grep -q 'consumed=ok'; then
        fail "corpus: consumed" "the Rust consumer reported $marker"
        return
    fi
    ok "corpus: $marker"

    # The browser consumer reads the same committed corpus, so a codec that
    # changes its bytes cannot pass in one language and fail in the other.
    local ts_dir="$REPO_ROOT/../tessellio-ts"
    if [ ! -d "$ts_dir" ]; then
        skip "corpus: the browser consumer (no repository at $ts_dir)"
        return
    fi
    if ! ( cd "$ts_dir" && npm test -- --run src/screen-op.test.ts ) \
            >"$LOGDIR/ts-consumer.log" 2>&1; then
        fail "corpus: consumed by the browser" "the browser consumer failed; its log follows"
        tail -20 "$LOGDIR/ts-consumer.log" >&2
        return
    fi
    ok "corpus: consumed by the browser"
}

# ── the checker's own check ─────────────────────────────────────────────────
#
# A gate that cannot fail is not a gate. Each case mutates a copy of the
# corpus and requires the gate to notice.

self_test() {
    local scratch
    scratch="$(mktemp -d "${TMPDIR:-/tmp}/tessellio-selftest-XXXXXX")"
    trap 'rm -rf "$scratch"' RETURN
    # The scratch copy sits beside the real repositories, so the checker
    # resolves the consumers as its siblings.
    local workspace="$scratch/workspace"
    mkdir -p "$workspace"
    cp -r "$CORPUS_DIR" "$workspace/tessellio-conformance"
    ln -s "$CORE_DIR" "$workspace/tessellio-core"
    ln -s "$REPO_ROOT/../tessellio-ts" "$workspace/tessellio-ts"
    scratch="$workspace/tessellio-conformance"

    local checks=0 failures=0

    # 1. A vector whose codec identity is wrong must be noticed.
    python3 - "$scratch/vectors.json" <<'PY'
import json
import sys

path = sys.argv[1]
document = json.load(open(path))
document["codec"]["name"] = "something-else"
json.dump(document, open(path, "w"), indent=2)
PY
    node "$REPO_ROOT/scripts/check-vectors.mjs" --repo "$scratch" >"$scratch.verdict" 2>&1 || true
    if grep -q 'problem(s)' "$scratch.verdict"; then
        checks=$((checks + 1))
    else
        echo "self-test: a wrong codec identity was not noticed" >&2
        failures=$((failures + 1))
    fi

    # 2. A vector whose payload is not hex must be noticed.
    cp "$REPO_ROOT/vectors.json" "$scratch/vectors.json"
    python3 - "$scratch/vectors.json" <<'PY'
import json
import sys

path = sys.argv[1]
document = json.load(open(path))
for vector in document["vectors"]:
    for chunk in vector["frames"][0]["chunks"]:
        if not chunk["regions"]:
            continue
        chunk["regions"][0]["payload"] = "not-hex"
        break
    else:
        continue
    break
json.dump(document, open(path, "w"), indent=2)
PY
    node "$REPO_ROOT/scripts/check-vectors.mjs" --repo "$scratch" >"$scratch.verdict" 2>&1 || true
    if grep -q 'problem(s)' "$scratch.verdict"; then
        checks=$((checks + 1))
    else
        echo "self-test: a tampered payload was not noticed" >&2
        failures=$((failures + 1))
    fi

    # 3. A corpus case whose expectation is not hex must be noticed.
    cp "$REPO_ROOT/vectors.json" "$scratch/vectors.json"
    python3 - "$scratch/corpus.json" <<'PY'
import json
import sys

path = sys.argv[1]
document = json.load(open(path))
for case in document["cases"]:
    for frame in case.get("frames", []):
        if "expect" in frame and "cells565" in frame["expect"]:
            frame["expect"]["cells565"] = "zz"
            break
    else:
        continue
    break
json.dump(document, open(path, "w"), indent=2)
PY
    node "$REPO_ROOT/scripts/check-vectors.mjs" --repo "$scratch" >"$scratch.verdict" 2>&1 || true
    if grep -q 'problem(s)' "$scratch.verdict"; then
        checks=$((checks + 1))
    else
        echo "self-test: a tampered expectation was not noticed" >&2
        failures=$((failures + 1))
    fi

    if [ "$failures" -eq 0 ]; then
        echo "self-test: $checks mutation(s) rejected"
        return 0
    fi
    echo "self-test: $failures mutation(s) were not rejected" >&2
    return 1
}

# ── main ────────────────────────────────────────────────────────────────────

echo "tessellio-conformance-gate: checking the corpus at $CORPUS_DIR"

if [ "$SELFTEST" = "1" ]; then
    if self_test; then
        exit 0
    fi
    exit 1
fi

if [ ! -d "$CORE_DIR" ]; then
    die "the reference implementation is missing at $CORE_DIR (set TESSELLIO_CORE_DIR)"
fi

static_check
check_corpus
check_consumer

if [ "$FAILURES" -eq 0 ]; then
    echo "tessellio-conformance-gate: all checks passed ($PASSES, $SKIPPED skipped)"
    exit 0
fi
echo "tessellio-conformance-gate: $FAILURES check(s) failed" >&2
exit 1
