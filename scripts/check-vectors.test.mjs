import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CORPUS_RELATIVE,
  EXPECTED_VECTOR_IDS,
  REPO_ROOT,
  RUST_CONSUMER_RELATIVE,
  TS_CONSUMER_RELATIVE,
  VECTORS_RELATIVE,
  checkConsumers,
  runCheck,
  validateCorpus,
  validateVectors,
} from './check-vectors.mjs';

function withFixture(files, callback) {
  // The fixture is a workspace: the corpus repository and its siblings. The
  // relative paths reach outside the fixture root on purpose, so the
  // fixture root is a *parent* of the corpus repository, and the temporary
  // directory is its grandparent — otherwise a write would escape it.
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'tessellio-vectors-'));
  const root = path.join(outer, 'workspace', 'tessellio-conformance');
  try {
    fs.mkdirSync(root, { recursive: true });
    for (const [relative, content] of Object.entries(files)) {
      const target = path.resolve(root, relative);
      if (!target.startsWith(path.resolve(outer) + path.sep)) {
        throw new Error(`the fixture would write outside its root: ${relative}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    return callback(root);
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8'));
}

function vectorsFixture() {
  return structuredClone(readJson(VECTORS_RELATIVE));
}

function corpusFixture() {
  return structuredClone(readJson(CORPUS_RELATIVE));
}

function expectError(errors, pattern) {
  assert.ok(
    errors.some((error) => pattern.test(error)),
    `expected a problem matching ${pattern}, got:\n${errors.join('\n')}`,
  );
}

test('the committed conformance files pass every rule', () => {
  const { errors, stats } = runCheck(REPO_ROOT);
  assert.deepEqual(errors, []);
  assert.equal(stats.vectors, 5);
  assert.ok(stats.corpusCases >= 64, `corpus carries ${stats.corpusCases} cases`);
  assert.ok(stats.bytes > 0);
});

test('both consumers resolve to the canonical corpus file', () => {
  assert.deepEqual(checkConsumers(REPO_ROOT), []);
});

test('the vectors file carries exactly the five documented ids', () => {
  const doc = vectorsFixture();
  assert.deepEqual(doc.vectors.map((vector) => vector.id), EXPECTED_VECTOR_IDS);
  const dropped = vectorsFixture();
  dropped.vectors.pop();
  expectError(validateVectors(dropped), /vector V5-chunked-frame-two-chunks is missing/);
  const duplicated = vectorsFixture();
  duplicated.vectors.push(structuredClone(duplicated.vectors[0]));
  expectError(validateVectors(duplicated), /expected 5 vectors|duplicate vector id/);
});

test('the vectors file pins the codec identity and schema', () => {
  const wrongSchema = vectorsFixture();
  wrongSchema.schema = 2;
  expectError(validateVectors(wrongSchema), /schema is 2, expected 1/);
  const wrongCodec = vectorsFixture();
  wrongCodec.codec.wireId = 9;
  expectError(validateVectors(wrongCodec), /codec must name tessellio with wire id 8/);
});

test('vectors hex must be even-length and lowercase', () => {
  const uppercase = vectorsFixture();
  uppercase.vectors[1].frames[0].chunks[0].regions[0].payload =
    uppercase.vectors[1].frames[0].chunks[0].regions[0].payload.toUpperCase();
  expectError(validateVectors(uppercase), /payload is not lowercase hex/);
  const odd = vectorsFixture();
  odd.vectors[1].frames[0].chunks[0].regions[0].payload += '0';
  expectError(validateVectors(odd), /payload has an odd hex length/);
});

test('vectors cells565 must be exactly the region canvas', () => {
  const wrongLength = vectorsFixture();
  wrongLength.vectors[1].frames[0].chunks[0].regions[0].cells565 += '00';
  expectError(validateVectors(wrongLength), /cells565 is \d+ bytes, expected \d+/);
});

test('vectors arithmetics: updateBytes, chunk identity, proto cross-reference', () => {
  const wrongBytes = vectorsFixture();
  wrongBytes.vectors[3].frames[0].chunks[0].updateBytes += 2;
  expectError(validateVectors(wrongBytes), /updateBytes \d+ does not equal the region payload sum/);

  const wrongCount = vectorsFixture();
  wrongCount.vectors[4].frames[0].chunks[1].count = 1;
  expectError(validateVectors(wrongCount), /declares count 1, expected 2/);

  const wrongIndex = vectorsFixture();
  wrongIndex.vectors[4].frames[0].chunks[0].index = 1;
  expectError(validateVectors(wrongIndex), /chunk at position 0 declares index 1/);

  const missingPayload = vectorsFixture();
  missingPayload.vectors[2].frames[0].chunks[0].regions[0].payload = '010b00f4ff010000020000010000f801';
  expectError(validateVectors(missingPayload), /does not occur in the chunk proto hex/);

  const outside = vectorsFixture();
  outside.vectors[1].frames[0].chunks[0].regions[0].x = 100;
  expectError(validateVectors(outside), /region is outside the frame/);
});

test('the corpus pins its schema and the canonical generator', () => {
  const wrongSchema = corpusFixture();
  wrongSchema.schema = 2;
  expectError(validateCorpus(wrongSchema), /schema is 2, expected 1/);
  const wrongGenerator = corpusFixture();
  wrongGenerator.generator = 'elsewhere';
  expectError(validateCorpus(wrongGenerator), /generator is "elsewhere"/);
});

test('the corpus carries at least 64 uniquely identified cases', () => {
  const small = corpusFixture();
  small.cases = small.cases.slice(0, 64 - 1);
  expectError(validateCorpus(small), /63 cases, expected at least 64/);
  const duplicated = corpusFixture();
  duplicated.cases.push(structuredClone(duplicated.cases[0]));
  expectError(validateCorpus(duplicated), /duplicate case id/);
  const unknownMode = corpusFixture();
  unknownMode.cases[0].mode = 'maybe';
  expectError(validateCorpus(unknownMode), /unknown mode/);
});

test('corpus roundtrip frames keep the chunk and hex arithmetic', () => {
  const wrongBytes = corpusFixture();
  const roundtrip = wrongBytes.cases.find((testCase) => testCase.mode === 'roundtrip');
  roundtrip.frames[0].chunks[0].updateBytes += 1;
  expectError(validateCorpus(wrongBytes), /updateBytes \d+ does not equal the region payload sum/);

  const wrongPixels = corpusFixture();
  const pixelsCase = wrongPixels.cases.find((testCase) => testCase.mode === 'roundtrip'
    && testCase.frames[0].expect.cells565 !== undefined);
  pixelsCase.frames[0].expect.cells565 += '00';
  expectError(validateCorpus(wrongPixels), /cells565 is \d+ bytes, expected \d+/);

  const wrongCrc = corpusFixture();
  const crcCase = wrongCrc.cases.find((testCase) => testCase.mode === 'roundtrip'
    && testCase.frames[0].expect.surfaceCrc32 !== undefined);
  crcCase.frames[0].expect.surfaceCrc32 = 'NOTHEX!';
  expectError(validateCorpus(wrongCrc), /surfaceCrc32 is not 8 lowercase hex digits/);
});

test('corpus expect-error cases keep a reason and an input', () => {
  const unknownReason = corpusFixture();
  unknownReason.cases.find((testCase) => testCase.mode === 'expect-error').reason = 'WHATEVER';
  expectError(validateCorpus(unknownReason), /is not a resync reason/);

  const withoutInput = corpusFixture();
  const errorCase = withoutInput.cases.find((testCase) => testCase.mode === 'expect-error');
  delete errorCase.payload;
  delete errorCase.chunk;
  delete errorCase.chunks;
  expectError(validateCorpus(withoutInput), /expect-error needs payload, chunk, or chunks/);

  const badCoverage = corpusFixture();
  badCoverage.cases.find((testCase) => testCase.mode === 'expect-error').coverage = 'partial';
  expectError(validateCorpus(badCoverage), /is not full or sparse/);

  const uppercase = corpusFixture();
  uppercase.cases.find((testCase) => testCase.mode === 'expect-error').payload = 'AB';
  expectError(validateCorpus(uppercase), /payload is not lowercase hex/);
});

test('the consumer check fails when a consumer points elsewhere', () => {
  const rustWithoutPaths = fs.readFileSync(path.join(REPO_ROOT, RUST_CONSUMER_RELATIVE), 'utf8')
    .replaceAll(CORPUS_RELATIVE, 'somewhere/else.json')
    .replaceAll(VECTORS_RELATIVE, 'somewhere/else.json');
  withFixture(
    {
      [RUST_CONSUMER_RELATIVE]: rustWithoutPaths,
      [TS_CONSUMER_RELATIVE]: fs.readFileSync(path.join(REPO_ROOT, TS_CONSUMER_RELATIVE), 'utf8'),
    },
    (root) => {
      const errors = checkConsumers(root);
      expectError(errors, /does not name corpus\.json/);
      expectError(errors, /does not name vectors\.json/);
    },
  );

  const tsPointingElsewhere = fs.readFileSync(path.join(REPO_ROOT, TS_CONSUMER_RELATIVE), 'utf8')
    .replace('"../../tessellio-conformance/corpus.json"',
      '"../../tessellio-conformance/corpus-copy.json"');
  withFixture(
    {
      [RUST_CONSUMER_RELATIVE]: fs.readFileSync(path.join(REPO_ROOT, RUST_CONSUMER_RELATIVE), 'utf8'),
      [TS_CONSUMER_RELATIVE]: tsPointingElsewhere,
    },
    (root) => {
      expectError(checkConsumers(root), /resolves its corpus to .*corpus-copy\.json/);
    },
  );
});

test('runCheck reports a missing conformance file', () => {
  withFixture({}, (root) => {
    const { errors, stats } = runCheck(root);
    expectError(errors, /vectors\.json: ENOENT/);
    expectError(errors, /corpus\.json: ENOENT/);
    assert.equal(stats.vectors, 0);
    assert.equal(stats.corpusCases, 0);
  });
});
