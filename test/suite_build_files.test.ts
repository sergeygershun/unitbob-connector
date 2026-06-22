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
    blocks: [{ block_id: 'billing', interfaces: [] }],
  });

  assert.equal(request.map_digest, 'sha256-map');
  assert.equal(request.output_path, outputPath(projectRoot));
  assert.equal(existsSync(requestPath(projectRoot)), true);
  assert.deepEqual(readSuiteBuildRequest(projectRoot), request);
});

test('reads the host output (spec_rb + test_metadata) and rejects malformed output', () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });

  const good = { spec_rb: "require 'rails_helper'\n", test_metadata: { capabilities: [] } };
  writeFileSync(outputPath(projectRoot), JSON.stringify(good));
  assert.deepEqual(readHostSuiteOutput(outputPath(projectRoot), projectRoot), good);

  writeFileSync(outputPath(projectRoot), 'I wrote some tests for you');
  assert.throws(() => readHostSuiteOutput(outputPath(projectRoot), projectRoot), /is not valid JSON/);

  writeFileSync(outputPath(projectRoot), '{ "test_metadata": {} }\n');
  assert.throws(() => readHostSuiteOutput(outputPath(projectRoot), projectRoot), /non-empty spec_rb/);

  writeFileSync(outputPath(projectRoot), '{ "spec_rb": "x" }\n');
  assert.throws(() => readHostSuiteOutput(outputPath(projectRoot), projectRoot), /missing test_metadata/);
});

test('reads spec_rb from a spec_rb_path when provided', () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'guardrails'), { recursive: true });
  const specPath = join('.unitbob', 'guardrails', 'architecture_map_contracts_spec.rb');
  writeFileSync(join(projectRoot, specPath), "require 'rails_helper'\n");
  writeFileSync(outputPath(projectRoot), JSON.stringify({ spec_rb_path: specPath, test_metadata: { capabilities: [] } }));

  assert.deepEqual(readHostSuiteOutput(outputPath(projectRoot), projectRoot), {
    spec_rb: "require 'rails_helper'\n",
    test_metadata: { capabilities: [] },
  });
});

test('readSuiteBuildRequest errors with guidance when the task is missing', () => {
  const projectRoot = tmpProject();
  assert.throws(() => readSuiteBuildRequest(projectRoot), /run `npx unitbob suite-prepare` first/);
});
