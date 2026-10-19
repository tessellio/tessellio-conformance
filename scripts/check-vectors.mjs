#!/usr/bin/env node
/**
 * Screen-codec conformance file gate (`just codec-vectors`).
 *
 * THE FILES IT GUARDS, AND WHY THEY ARE GUARDED STATICALLY
 * =======================================================
 * `conformance/vectors.json` holds five hand-derived wire vectors
 * (stored DEFLATE blocks, so every byte is verifiable by hand) that pin the
 * payload format of the `tessellio` screen-stream codec.
 * `conformance/corpus.json` is the generated conformance corpus
 * (>= 64 cases) read by **both** decoders: the Rust conformance oracle in
 * the reference implementation and the browser test.
 *
 * The dynamic half of that contract lives in the gate: `cargo-gate.sh`'s
 * `codec_corpus()` step regenerates the corpus, compares it byte for byte with
 * the committed file, and requires the Rust consumer to print its
 * `codec-conformance: ... consumed=ok` marker. This step is the static half:
 * it validates the two files' schema, arithmetic and cross-references, and it
 * asserts that the two consumers both resolve to the same canonical corpus
 * file, so a consumer pointed at a second copy fails here rather than reading a
 * file nothing regenerates.
 *
 * WHAT IS CHECKED
 * ===============
 * Vectors (`vectors.json`):
 *   - `schema == 1`, the codec identity (`tessellio`, wire id 8), and the five
 *     documented vector ids (a deletion or rename is a failure, not a smaller
 *     green run);
 *   - every `payload`, `cells565`, part `proto` and `surfaceCrc32` is
 *     even-length, lowercase hex (uppercase hex is rejected so the file stays
 *     byte-comparable with the Rust test's normalizer);
 *   - per frame: part indices are exactly `0..count-1` in order, every part
 *     repeats the frame's `count`/`updateBytes`, and `updateBytes` equals the sum
 *     of the frame's region payload lengths;
 *   - per part: every region's payload hex occurs inside the part's
 *     `proto` hex (the hand-derived part bytes and the region payloads cannot
 *     drift apart);
 *   - per region: bounds inside the frame, `1..=262144` payload bytes, and,
 *     when present, `cells565` exactly `width * height * 2` bytes of hex.
 *
 * Corpus (`corpus.json`):
 *   - `schema == 1` and the canonical generator name;
 *   - at least 64 cases with unique ids, each a `roundtrip` or an
 *     `expect-error` case with one of its three inputs;
 *   - `roundtrip`: the same part identity, `updateBytes` arithmetic and hex
 *     rules as the vectors, `surfaceCrc32` as 8 lowercase hex digits when used
 *     instead of full `cells565`;
 *   - `expect-error`: the reason is one of the codec's eight resync reasons.
 *
 * Consumers:
 *   - the Rust conformance test names both canonical paths (it resolves them
 *     from the repository root);
 *   - the frontend corpus consumer's relative path resolves to the canonical
 *     `conformance/corpus.json`.
 *
 * Usage: node scripts/dev/screen-codec-vectors.mjs [--check] [--repo <dir>]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The workspace the conformance repository and its siblings live in. */
export const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..');

export const VECTORS_RELATIVE = 'vectors.json';
export const CORPUS_RELATIVE = 'corpus.json';
export const RUST_CONSUMER_RELATIVE = '../tessellio-core/tests/codec_conformance.rs';
export const TS_CONSUMER_RELATIVE = '../tessellio-ts/src/op-stream.test.ts';

/** The eight resync reasons of the wire contract (design §4.6). */
export const RESYNC_REASONS = [
  'BASE_MISMATCH',
  'INCOMPLETE_UPDATE',
  'DECODE_ERROR',
  'COVERAGE_INVALID',
  'UNKNOWN_CODEC',
  'QUEUE_OVERFLOW',
  'GEOMETRY_MISMATCH',
  'PART_GAP',
];

/** The five documented vectors, by id. */
export const EXPECTED_VECTOR_IDS = [
  'V1-empty-delta-idle-update',
  'V2-literal-run-sparse-delta',
  'V3-full-coverage-multi-row-fill-self-contained',
  'V4-multi-region-sparse-delta',
  'V5-parted-update-two-parts',
];

/** The one canonical corpus generator. */
export const CORPUS_GENERATOR = 'tessellio-core/tests/codec_corpus_gen.rs';

export const CORPUS_MIN_CASES = 64;

/** Wire limits the files must respect (design §4.4). */
export const LIMITS = {
  maxFrameDimension: 8192,
  maxFramePixels: 16777216,
  maxChunksPerFrame: 8,
  maxRegionsPerChunk: 32,
  maxRegionWireBytes: 262144,
};

const HEX_RE = /^[0-9a-f]*$/;

function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * `null` when `value` is an even-length lowercase hex string, otherwise the
 * reason it is not. An empty string is valid: the corpus carries a
 * zero-length-payload corruption case.
 */
function hexProblem(value, { allowEmpty = true } = {}) {
  if (typeof value !== 'string') {
    return 'is not a string';
  }
  if (value.length % 2 !== 0) {
    return 'has an odd hex length';
  }
  if (!HEX_RE.test(value)) {
    return 'is not lowercase hex';
  }
  if (!allowEmpty && value.length === 0) {
    return 'is empty';
  }
  return null;
}

function payloadBytes(hex) {
  return hex.length / 2;
}

/** Validate one part in the shape the vectors and the corpus share. */
function validateChunk(part, frame, where, errors, { requireProto }) {
  const label = `${where} part[${part?.index}]`;
  if (!part || typeof part !== 'object') {
    errors.push(`${label}: not an object`);
    return 0;
  }
  if (!isInteger(part.index) || part.index < 0) {
    errors.push(`${label}: index is not a non-negative integer`);
  }
  if (!isInteger(part.count) || part.count < 1 || part.count > LIMITS.maxChunksPerFrame) {
    errors.push(`${label}: count is not in 1..=${LIMITS.maxChunksPerFrame}`);
  }
  if (!isInteger(part.updateBytes) || part.updateBytes < 0) {
    errors.push(`${label}: updateBytes is not a non-negative integer`);
  }
  if (requireProto) {
    const problem = hexProblem(part.proto, { allowEmpty: false });
    if (problem) {
      errors.push(`${label}: proto ${problem}`);
    }
  }

  const regions = part.regions;
  if (!Array.isArray(regions)) {
    errors.push(`${label}: regions is not an array`);
    return 0;
  }
  if (regions.length > LIMITS.maxRegionsPerChunk) {
    errors.push(`${label}: ${regions.length} regions exceeds the ${LIMITS.maxRegionsPerChunk} per-part cap`);
  }

  let bytes = 0;
  for (const [index, region] of regions.entries()) {
    const regionLabel = `${label} region[${index}]`;
    if (!region || typeof region !== 'object') {
      errors.push(`${regionLabel}: not an object`);
      continue;
    }
    const fields = ['x', 'y', 'width', 'height'];
    if (fields.some((field) => !isInteger(region[field]))) {
      errors.push(`${regionLabel}: x/y/width/height must be integers`);
      continue;
    }
    if (region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1) {
      errors.push(`${regionLabel}: x/y must be >= 0 and width/height >= 1`);
    }
    if (!isInteger(frame.width) || !isInteger(frame.height)
      || region.x + region.width > frame.width || region.y + region.height > frame.height) {
      errors.push(`${regionLabel}: region is outside the frame`);
    }
    const payloadProblem = hexProblem(region.payload, { allowEmpty: false });
    if (payloadProblem) {
      errors.push(`${regionLabel}: payload ${payloadProblem}`);
    } else {
      bytes += payloadBytes(region.payload);
      if (payloadBytes(region.payload) > LIMITS.maxRegionWireBytes) {
        errors.push(`${regionLabel}: payload exceeds the ${LIMITS.maxRegionWireBytes}-byte wire cap`);
      }
    }
    if (requireProto && !payloadProblem && typeof part.proto === 'string'
      && !part.proto.includes(region.payload)) {
      errors.push(`${regionLabel}: payload hex does not occur in the part proto hex`);
    }
    if (region.cells565 !== undefined) {
      const problem = hexProblem(region.cells565);
      if (problem) {
        errors.push(`${regionLabel}: cells565 ${problem}`);
      } else if (isInteger(region.width) && isInteger(region.height)
        && region.cells565.length !== region.width * region.height * 4) {
        errors.push(`${regionLabel}: cells565 is ${region.cells565.length / 2} bytes, expected `
          + `${region.width * region.height * 2}`);
      }
    }
  }
  return bytes;
}

/** Validate the part set of one frame and return its payload-byte sum. */
function validateFrameChunks(frame, where, errors, { requireProto }) {
  const label = `${where} frame ${frame?.updateId}`;
  if (!frame || typeof frame !== 'object') {
    errors.push(`${where}: frame is not an object`);
    return 0;
  }
  if (!isInteger(frame.updateId) || frame.updateId < 1) {
    errors.push(`${label}: updateId is not >= 1`);
  }
  if (!isInteger(frame.baseUpdateId) || frame.baseUpdateId < 0) {
    errors.push(`${label}: baseUpdateId is not >= 0`);
  }
  for (const field of ['width', 'height']) {
    if (!isInteger(frame[field]) || frame[field] < 1 || frame[field] > LIMITS.maxFrameDimension) {
      errors.push(`${label}: ${field} is not in 1..=${LIMITS.maxFrameDimension}`);
    }
  }
  if (isInteger(frame.width) && isInteger(frame.height)
    && frame.width * frame.height > LIMITS.maxFramePixels) {
    errors.push(`${label}: ${frame.width}x${frame.height} exceeds the pixel cap`);
  }
  if (!Array.isArray(frame.parts) || frame.parts.length === 0) {
    errors.push(`${label}: parts is not a non-empty array`);
    return 0;
  }
  const count = frame.parts.length;
  let bytes = 0;
  frame.parts.forEach((part, index) => {
    bytes += validateChunk(part, frame, label, errors, { requireProto });
    if (isInteger(part?.index) && part.index !== index) {
      errors.push(`${label}: part at position ${index} declares index ${part.index}`);
    }
    if (isInteger(part?.count) && part.count !== count) {
      errors.push(`${label}: part ${index} declares count ${part.count}, expected ${count}`);
    }
  });
  const declared = frame.parts.map((part) => part?.updateBytes);
  for (const value of declared) {
    if (isInteger(value) && value !== bytes) {
      errors.push(`${label}: updateBytes ${value} does not equal the region payload sum ${bytes}`);
      break;
    }
  }
  return bytes;
}

function validateFrameExpect(frame, where, errors) {
  const expect = frame.expect;
  if (expect === undefined) {
    errors.push(`${where}: expect is missing`);
    return;
  }
  if (expect.ack !== undefined && expect.ack !== true) {
    errors.push(`${where}: expect.ack is not true`);
  }
  if (expect.appliedFrameId !== undefined && !isInteger(expect.appliedFrameId)) {
    errors.push(`${where}: expect.appliedFrameId is not an integer`);
  }
}

/** Validate `vectors.json`; returns a list of problems (empty means valid). */
export function validateVectors(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') {
    return ['vectors.json: not a JSON object'];
  }
  if (doc.schema !== 1) {
    errors.push(`vectors.json: schema is ${JSON.stringify(doc.schema)}, expected 1`);
  }
  if (doc.codec?.name !== 'tessellio' || doc.codec?.wireId !== 8) {
    errors.push('vectors.json: codec must name tessellio with wire id 8');
  }
  if (!Array.isArray(doc.vectors)) {
    return [...errors, 'vectors.json: vectors is not an array'];
  }
  const ids = doc.vectors.map((vector) => vector?.id);
  if (ids.length !== EXPECTED_VECTOR_IDS.length) {
    errors.push(`vectors.json: ${ids.length} vectors, expected ${EXPECTED_VECTOR_IDS.length}`);
  }
  for (const id of EXPECTED_VECTOR_IDS) {
    if (!ids.includes(id)) {
      errors.push(`vectors.json: vector ${id} is missing`);
    }
  }
  for (const id of new Set(ids)) {
    if (ids.filter((candidate) => candidate === id).length > 1) {
      errors.push(`vectors.json: duplicate vector id ${id}`);
    }
  }
  for (const vector of doc.vectors) {
    const label = `vector ${vector?.id}`;
    if (!vector || typeof vector !== 'object') {
      errors.push('vectors.json: vector is not an object');
      continue;
    }
    if (!Array.isArray(vector.frames) || vector.frames.length === 0) {
      errors.push(`${label}: frames is not a non-empty array`);
      continue;
    }
    for (const frame of vector.frames) {
      validateFrameChunks(frame, label, errors, { requireProto: true });
      validateFrameExpect(frame, `${label} frame ${frame?.updateId}`, errors);
    }
  }
  return errors;
}

/**
 * Validate a standalone part fixture (the corpus `expect-error` shapes that
 * carry `part` or `parts`). These fixtures are the *corrupted* inputs the
 * codec must refuse, so only the shape and the hex format are checked here:
 * a region deliberately outside its frame, or an empty payload, is the case
 * under test, not a file defect.
 */
function validateStandaloneChunk(part, where, errors) {
  const label = `${where} part`;
  if (!part || typeof part !== 'object') {
    errors.push(`${label}: not an object`);
    return;
  }
  for (const field of ['updateId', 'baseUpdateId', 'width', 'height', 'partIndex', 'partCount', 'updateBytes', 'codec']) {
    if (!isInteger(part[field])) {
      errors.push(`${label}: ${field} is not an integer`);
    }
  }
  if (!Array.isArray(part.regions)) {
    errors.push(`${label}: regions is not an array`);
    return;
  }
  for (const [index, region] of part.regions.entries()) {
    if (!region || typeof region !== 'object'
      || ['x', 'y', 'width', 'height'].some((field) => !isInteger(region[field]))) {
      errors.push(`${label} region[${index}]: x/y/width/height must be integers`);
      continue;
    }
    const problem = hexProblem(region.payload);
    if (problem) {
      errors.push(`${label} region[${index}]: payload ${problem}`);
    }
  }
}

/** Validate `corpus.json`; returns a list of problems (empty means valid). */
export function validateCorpus(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') {
    return ['corpus.json: not a JSON object'];
  }
  if (doc.schema !== 1) {
    errors.push(`corpus.json: schema is ${JSON.stringify(doc.schema)}, expected 1`);
  }
  if (doc.generator !== CORPUS_GENERATOR) {
    errors.push(`corpus.json: generator is ${JSON.stringify(doc.generator)}, expected ${CORPUS_GENERATOR}`);
  }
  if (!Array.isArray(doc.cases)) {
    return [...errors, 'corpus.json: cases is not an array'];
  }
  if (doc.cases.length < CORPUS_MIN_CASES) {
    errors.push(`corpus.json: ${doc.cases.length} cases, expected at least ${CORPUS_MIN_CASES}`);
  }
  const ids = doc.cases.map((testCase) => testCase?.id);
  for (const id of new Set(ids)) {
    if (ids.filter((candidate) => candidate === id).length > 1) {
      errors.push(`corpus.json: duplicate case id ${id}`);
    }
  }
  for (const testCase of doc.cases) {
    const label = `corpus case ${testCase?.id}`;
    if (!testCase || typeof testCase !== 'object' || typeof testCase.id !== 'string' || testCase.id.length === 0) {
      errors.push('corpus.json: case is not an object with a non-empty id');
      continue;
    }
    if (testCase.mode === 'roundtrip') {
      if (!Array.isArray(testCase.frames) || testCase.frames.length === 0) {
        errors.push(`${label}: frames is not a non-empty array`);
        continue;
      }
      for (const frame of testCase.frames) {
        validateFrameChunks(frame, label, errors, { requireProto: false });
        validateFrameExpect(frame, `${label} frame ${frame?.updateId}`, errors);
        const expect = frame?.expect ?? {};
        if (expect.cells565 !== undefined) {
          const problem = hexProblem(expect.cells565);
          if (problem) {
            errors.push(`${label} frame ${frame?.updateId}: cells565 ${problem}`);
          } else if (isInteger(frame.width) && isInteger(frame.height)
            && expect.cells565.length !== frame.width * frame.height * 4) {
            errors.push(`${label} frame ${frame?.updateId}: cells565 is `
              + `${expect.cells565.length / 2} bytes, expected ${frame.width * frame.height * 2}`);
          }
        }
        if (expect.surfaceCrc32 !== undefined && !/^[0-9a-f]{8}$/.test(expect.surfaceCrc32)) {
          errors.push(`${label} frame ${frame?.updateId}: surfaceCrc32 is not 8 lowercase hex digits`);
        }
        if (expect.cells565 === undefined && expect.surfaceCrc32 === undefined) {
          errors.push(`${label} frame ${frame?.updateId}: neither cells565 nor surfaceCrc32 is recorded`);
        }
      }
      continue;
    }
    if (testCase.mode === 'expect-error') {
      if (!RESYNC_REASONS.includes(testCase.reason)) {
        errors.push(`${label}: reason ${JSON.stringify(testCase.reason)} is not a resync reason`);
      }
      const carries = ['payload', 'part', 'parts'].some((key) => testCase[key] !== undefined);
      if (!carries) {
        errors.push(`${label}: expect-error needs payload, part, or parts`);
      }
      if (testCase.payload !== undefined) {
        const problem = hexProblem(testCase.payload);
        if (problem) {
          errors.push(`${label}: payload ${problem}`);
        }
      }
      if (testCase.region !== undefined
        && (!isInteger(testCase.region.width) || !isInteger(testCase.region.height))) {
        errors.push(`${label}: region must carry integer width/height`);
      }
      if (testCase.coverage !== undefined && !['full', 'sparse'].includes(testCase.coverage)) {
        errors.push(`${label}: coverage ${JSON.stringify(testCase.coverage)} is not full or sparse`);
      }
      if (testCase.part !== undefined) {
        validateStandaloneChunk(testCase.part, label, errors);
      }
      if (testCase.parts !== undefined) {
        if (!Array.isArray(testCase.parts) || testCase.parts.length === 0) {
          errors.push(`${label}: parts is not a non-empty array`);
        } else {
          for (const part of testCase.parts) {
            validateStandaloneChunk(part, label, errors);
          }
        }
      }
      continue;
    }
    errors.push(`${label}: unknown mode ${JSON.stringify(testCase.mode)}`);
  }
  return errors;
}

/**
 * The static consumer cross-reference: the Rust conformance test and the
 * frontend corpus consumer must resolve to the one canonical corpus file.
 */
export function checkConsumers(root = REPO_ROOT) {
  // The consumers are the workspace's siblings.
  const errors = [];
  const rustPath = path.resolve(root, RUST_CONSUMER_RELATIVE);
  const tsPath = path.resolve(root, TS_CONSUMER_RELATIVE);

  let rustSource;
  try {
    rustSource = fs.readFileSync(rustPath, 'utf8');
  } catch {
    return [`${RUST_CONSUMER_RELATIVE} is not readable`];
  }
  for (const relative of [CORPUS_RELATIVE, VECTORS_RELATIVE]) {
    if (!rustSource.includes(relative)) {
      errors.push(`${RUST_CONSUMER_RELATIVE} does not name ${relative}`);
    }
  }
  if (!rustSource.includes('TESSELLIO_CORPUS')) {
    errors.push(`${RUST_CONSUMER_RELATIVE} does not name the TESSELLIO_CORPUS override`);
  }

  let tsSource;
  try {
    tsSource = fs.readFileSync(tsPath, 'utf8');
  } catch {
    return [`${TS_CONSUMER_RELATIVE} is not readable`];
  }
  const match = tsSource.match(/"([^"]*conformance\/[^"]*\.json)"/);
  if (!match) {
    errors.push(`${TS_CONSUMER_RELATIVE} does not name a relative path under conformance/`);
  } else {
    const resolved = path.resolve(path.dirname(tsPath), match[1]);
    const canonical = path.join(root, CORPUS_RELATIVE);
    if (resolved !== canonical) {
      errors.push(`${TS_CONSUMER_RELATIVE} resolves its corpus to ${resolved}, not ${canonical}`);
    }
  }
  return errors;
}

function readJson(absolute, label) {
  try {
    return { value: JSON.parse(fs.readFileSync(absolute, 'utf8')) };
  } catch (error) {
    return { error: `${label}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Run every rule and return `{ errors, stats }`. */
export function runCheck(root = REPO_ROOT) {
  const errors = [];
  const vectorsPath = path.join(root, VECTORS_RELATIVE);
  const corpusPath = path.join(root, CORPUS_RELATIVE);

  const vectors = readJson(vectorsPath, VECTORS_RELATIVE);
  const corpus = readJson(corpusPath, CORPUS_RELATIVE);
  if (vectors.error) {
    errors.push(vectors.error);
  } else {
    errors.push(...validateVectors(vectors.value));
  }
  if (corpus.error) {
    errors.push(corpus.error);
  } else {
    errors.push(...validateCorpus(corpus.value));
  }
  errors.push(...checkConsumers(root));

  const stats = {
    vectors: Array.isArray(vectors.value?.vectors) ? vectors.value.vectors.length : 0,
    corpusCases: Array.isArray(corpus.value?.cases) ? corpus.value.cases.length : 0,
    bytes: fs.existsSync(corpusPath) ? fs.statSync(corpusPath).size : 0,
  };
  return { errors, stats };
}

function main() {
  const args = process.argv.slice(2);
  let root = REPO_ROOT;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--check') {
      continue;
    }
    if (arg === '--repo') {
      root = path.resolve(args[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/dev/screen-codec-vectors.mjs [--check] [--repo <dir>]');
      return;
    }
    console.error(`codec-vectors: unknown argument ${arg}`);
    process.exitCode = 2;
    return;
  }

  const { errors, stats } = runCheck(root);
  if (errors.length > 0) {
    console.error('codec-vectors: conformance file problems');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    console.error(`codec-vectors: ${errors.length} problem(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(`codec-vectors: vectors=${stats.vectors} corpusCases=${stats.corpusCases} bytes=${stats.bytes}`);
}

const isDirectRun =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main();
}
