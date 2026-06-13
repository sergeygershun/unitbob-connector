import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  outputPath,
  readHostSuiteOutput,
  readSuiteBuildRequest,
  requestPath,
  writeSuiteBuildRequest,
} from '../src/files/suiteBuild.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-suite-build-files-'));
}

test('writes and round-trips the suite build request', () => {
  const projectRoot = tmpProject();

  const request = writeSuiteBuildRequest(projectRoot, {
    map_digest: 'sha256-map',
    recipe: { name: 'generate', version: 'g1', text: 'generate recipe' },
    packets: [{ block: { id: 'block:billing' } }],
  });

  assert.equal(request.map_digest, 'sha256-map');
  assert.equal(request.output_path, outputPath(projectRoot));
  assert.equal(existsSync(requestPath(projectRoot)), true);
  assert.deepEqual(readSuiteBuildRequest(projectRoot), request);
});

test('reads the host output blocks and rejects malformed output', () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });

  writeFileSync(outputPath(projectRoot), '{ "blocks": [{ "block_id": "block:billing" }] }\n');
  assert.deepEqual(readHostSuiteOutput(outputPath(projectRoot)), { blocks: [{ block_id: 'block:billing' }] });

  writeFileSync(outputPath(projectRoot), 'I wrote some tests for you');
  assert.throws(() => readHostSuiteOutput(outputPath(projectRoot)), /is not valid JSON/);

  writeFileSync(outputPath(projectRoot), '{ "notblocks": [] }\n');
  assert.throws(() => readHostSuiteOutput(outputPath(projectRoot)), /expected an object with a "blocks" array/);
});

test('readSuiteBuildRequest errors with guidance when the task is missing', () => {
  const projectRoot = tmpProject();
  assert.throws(() => readSuiteBuildRequest(projectRoot), /run `npx unitbob suite-prepare` first/);
});
