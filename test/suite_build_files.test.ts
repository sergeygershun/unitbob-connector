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
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-suite-build-files-'));
  mkdirSync(join(dir, '.unitbob', 'suite-build'), { recursive: true });
  return dir;
}

const SUITE_PATH = '.unitbob/guardrails/architecture_map_contracts_spec.rb';

function goodOutput(): Record<string, unknown> {
  return {
    suite_file: { path: SUITE_PATH, content: "require 'rails_helper'\n" },
    runner_manifest: { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' },
    test_metadata: { capabilities: [] },
  };
}

function writeOutput(projectRoot: string, output: unknown): string {
  const path = outputPath(projectRoot);
  writeFileSync(path, typeof output === 'string' ? output : JSON.stringify(output));
  return path;
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

test('reads the host output (suite_file + runner_manifest + test_metadata)', () => {
  const projectRoot = tmpProject();
  const path = writeOutput(projectRoot, goodOutput());

  assert.deepEqual(readHostSuiteOutput(path, projectRoot), goodOutput());
});

test('rejects malformed or incomplete host output', () => {
  const projectRoot = tmpProject();

  let path = writeOutput(projectRoot, 'I wrote some tests for you');
  assert.throws(() => readHostSuiteOutput(path, projectRoot), /is not valid JSON/);

  path = writeOutput(projectRoot, { ...goodOutput(), test_metadata: undefined });
  assert.throws(() => readHostSuiteOutput(path, projectRoot), /missing test_metadata/);

  path = writeOutput(projectRoot, { ...goodOutput(), runner_manifest: undefined });
  assert.throws(() => readHostSuiteOutput(path, projectRoot), /missing runner_manifest/);

  path = writeOutput(projectRoot, { ...goodOutput(), suite_file: 'inline ruby' });
  assert.throws(() => readHostSuiteOutput(path, projectRoot), /suite_file \{ path, content \}/);
});

test('rejects the legacy spec_rb shape', () => {
  const projectRoot = tmpProject();
  const path = writeOutput(projectRoot, { spec_rb: "require 'rails_helper'\n", test_metadata: { capabilities: [] } });

  assert.throws(() => readHostSuiteOutput(path, projectRoot), /legacy spec_rb shape/);
});

test('rejects unsafe suite_file paths (absolute, outside the dir, traversal)', () => {
  const projectRoot = tmpProject();

  for (const unsafe of ['/etc/passwd', 'spec/pwned_spec.rb', '.unitbob/guardrails/../../pwned.rb']) {
    const output = goodOutput();
    (output.suite_file as Record<string, unknown>).path = unsafe;
    const path = writeOutput(projectRoot, output);
    assert.throws(() => readHostSuiteOutput(path, projectRoot), /relative path under/, unsafe);
  }
});

test('reads content from the file the host already wrote when content is not inlined', () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'guardrails'), { recursive: true });
  writeFileSync(join(projectRoot, SUITE_PATH), "require 'rails_helper'\n");
  const output = goodOutput();
  delete (output.suite_file as Record<string, unknown>).content;
  const path = writeOutput(projectRoot, output);

  assert.deepEqual(readHostSuiteOutput(path, projectRoot).suite_file, {
    path: SUITE_PATH,
    content: "require 'rails_helper'\n",
  });
});

test('rejects a suite_file with neither content nor a file on disk', () => {
  const projectRoot = tmpProject();
  const output = goodOutput();
  delete (output.suite_file as Record<string, unknown>).content;
  const path = writeOutput(projectRoot, output);

  assert.throws(() => readHostSuiteOutput(path, projectRoot), /does not exist in the project/);
});

test('readSuiteBuildRequest errors with guidance when the task is missing', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-no-task-'));
  assert.throws(() => readSuiteBuildRequest(projectRoot), /run `npx unitbob suite-prepare` first/);
});
