# Tessellio Conformance

The conformance corpus of the **Tessellio** screen codec, and the gate that
keeps it honest.

The corpus is the codec's shared, executable description of what it promises.
It is read by **both** implementations:

| Consumer | Resolves | Contract |
|---|---|---|
| The reference implementation | `tessellio-core/tests/codec_corpus_gen.rs`, compiled by the gate | regenerates the corpus; the gate then compares it byte for byte |
| The browser implementation | `tessellio-ts/src/screen-op.test.ts` | replays every committed case through the decoder and requires the committed expectations to hold |

There is exactly **one** corpus file. The gate asserts that both consumers
resolve to it, so a consumer pointed at a second copy fails there rather than
reading a file nothing regenerates.

## Why a mismatch is a failure

A corpus case is not documentation: it is the record of what the codec
produced, byte for byte, under a committed input. A codec change that alters
any byte changes the corpus, and the gate regenerates it and compares it
**byte for byte**. A difference means the committed corpus no longer
describes what the code does, so either the code change was not reviewed as
a format change, or the corpus was edited by hand. Both are failures by
construction. When the change is intended, it is committed together with the
regenerated corpus (`scripts/conformance-gate.sh --update`) and the diff is
part of the change's review.

## Layout

```
corpus.json   the generated corpus: 72 cases, each with its frames and the
              cells the receiver must end up holding
vectors.json  five hand-derived wire vectors: every payload is a stored
              DEFLATE block, so every byte is verifiable by hand
scripts/      the static checker, its own unit suite, and the gate
```

## Running the gate

```bash
scripts/conformance-gate.sh             # run it
scripts/conformance-gate.sh --update    # regenerate the corpus in place
scripts/conformance-gate.sh --self-test # check the checker
```

The gate needs Node, a Rust toolchain, and Python 3, and nothing else, so it
runs the same in a container and on a developer machine. The reference
implementation is expected next to this repository as `../tessellio-core`;
`TESSELLIO_CORE_DIR` overrides that.

## What the gate checks

1. **The corpus's own shape.** The vectors carry the codec's identity and
   every one of their bytes; the corpus's cases are complete, unique, and
   carry the expectations the decoder must meet.
2. **The corpus is reproducible.** The reference implementation regenerates
   it, and the result must be byte-identical to the committed file.
3. **The corpus was actually read.** The generator's "no corpus" marker is
   counted and required to be zero, and the consumers' own summary markers
   are required to report a successful consumption — so a deleted or
   unreadable corpus cannot pass as a green run that compared nothing.
4. **The gate itself.** `--self-test` mutates a copy of the corpus three
   ways and requires each mutation to be noticed. A gate that cannot fail is
   not a gate.

## The vectors

The five vectors are hand-derived from the specification, and every payload is
a **stored** DEFLATE block, so each byte can be checked against the
specification by eye:

| Vector | What it pins |
|---|---|
| `V1-empty-delta-idle-frame` | the header alone is a complete, applyable update |
| `V2-literal-run-sparse-delta` | a literal run, and the row the op stream never writes |
| `V3-full-coverage-multi-row-fill-reset` | a self-contained update covering the whole surface |
| `V4-multi-region-sparse-delta` | several regions, byte-disjoint, in one update |
| `V5-chunked-frame-two-chunks` | an update split into two parts, and their byte arithmetic |

## The corpus

Each case names an input, the frames the encoder produced, and the cells the
receiver must hold afterwards. The cases cover the flat surfaces, the office
surfaces, the noisy surfaces, the pointer moves at one and sixteen cells, the
typing bursts, the scrolls, the interrupted assemblies, and the cases that
must be rejected.

The corpus is generated, never written by hand.

## Adding a case

1. Add the case to the generator in `tessellio-core/tests/codec_corpus_gen.rs`.
2. Run `scripts/conformance-gate.sh --update` and commit the regenerated
   corpus.
3. Extend the static checker if the case exercises a rule it does not yet
   enforce.

## Status

In development. One moving version, `v0.1.0`, naming the current commit:
there is exactly one tag, and a change moves it.

## Licence

PolyForm Noncommercial License 1.0.0. See [LICENSE](LICENSE).

## The sibling repositories

| repository | what it holds |
|---|---|
| [`tessellio`](https://github.com/tessellio/tessellio) | the normative specification |
| [`tessellio-core`](https://github.com/tessellio/tessellio-core) | the Rust reference implementation, and the codec's command-line tool |
| [`tessellio-ts`](https://github.com/tessellio/tessellio-ts) | the browser reference implementation |
| [`tessellio-proto`](https://github.com/tessellio/tessellio-proto) | the update envelope's wire schema |
| [`tessellio-conformance`](https://github.com/tessellio/tessellio-conformance) | the conformance corpus and its gate |
