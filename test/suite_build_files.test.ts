import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  outputPath,
  readHostSuiteOutputs,
  readSuiteBuildRequest,
  recipeNameFor,
  requestPath,
  suiteCandidateDigest,
  writeSuiteBuildRequest,
  type SuiteBuildBranch,
} from '../src/files/suiteBuild.ts';
import type { SuitePacket } from '../src/wire.ts';

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-suite-build-files-'));
  mkdirSync(join(dir, '.unitbob', 'suite-build'), { recursive: true });
  return dir;
}

function branches(): SuiteBuildBranch[] {
  return [
    {
      suite_kind: 'structural', source_digest: 'map-d', path_root: '.unitbob/structural/',
      recipe: { name: 'generate', version: 'g1', text: 'g' }, assignment: { blocks: [] },
    },
    {
      suite_kind: 'behavioral', source_digest: 'surface-d', path_root: '.unitbob/behavioral/',
      recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' }, assignment: { capabilities: [] },
    },
  ];
}

function structuralBranch(): Record<string, unknown> {
  return {
    suite_kind: 'structural',
    suite_file: { path: '.unitbob/structural/architecture_map_contracts_spec.rb', content: "require 'x'\n" },
    runner_manifest: { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' },
    test_metadata: { capabilities: [] },
  };
}

function behavioralBranch(): Record<string, unknown> {
  return {
    suite_kind: 'behavioral',
    suite_file: {
      path: '.unitbob/behavioral/features/surface_contracts.feature',
      content: 'Feature: x\n',
      support_files: [{ path: '.unitbob/behavioral/step_definitions/surface_steps.rb', content: '# steps\n' }],
    },
    runner_manifest: {
      language: 'ruby', framework: 'cucumber', result_format: 'cucumber_messages',
      runner: 'cucumber', package_manager: 'bundler', runner_version: '9.2.0',
    },
    test_metadata: { capabilities: [] },
  };
}

function writeTask(projectRoot: string): void {
  writeSuiteBuildRequest(projectRoot, branches());
}

function writeOutput(projectRoot: string, output: unknown): string {
  const path = outputPath(projectRoot);
  writeFileSync(path, typeof output === 'string' ? output : JSON.stringify(output));
  return path;
}

test('writes and round-trips the two-branch suite build request', () => {
  const projectRoot = tmpProject();
  const request = writeSuiteBuildRequest(projectRoot, branches());

  assert.equal(request.output_path, outputPath(projectRoot));
  assert.equal(existsSync(requestPath(projectRoot)), true);
  assert.deepEqual(readSuiteBuildRequest(projectRoot), request);
  assert.deepEqual(request.branches.map((branch) => branch.suite_kind), ['structural', 'behavioral']);
});

test('reads both branch outputs, keeping each artifact envelope', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const path = writeOutput(projectRoot, { branches: [structuralBranch(), behavioralBranch()] });

  const outputs = readHostSuiteOutputs(path, readSuiteBuildRequest(projectRoot));
  assert.deepEqual(outputs.map((output) => output.suite_kind), ['structural', 'behavioral']);
  assert.deepEqual(outputs[1].suite_file, behavioralBranch().suite_file);
});

test('relays a branch build_error', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const path = writeOutput(projectRoot, {
    branches: [structuralBranch(), { suite_kind: 'behavioral', build_error: { message: 'no cucumber here' } }],
  });

  const outputs = readHostSuiteOutputs(path, readSuiteBuildRequest(projectRoot));
  assert.equal(outputs[1].build_error?.message, 'no cucumber here');
  assert.equal(outputs[1].suite_file, undefined);
});

test('rejects malformed or incomplete branch output', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const request = readSuiteBuildRequest(projectRoot);

  let path = writeOutput(projectRoot, 'I wrote some tests for you');
  assert.throws(() => readHostSuiteOutputs(path, request), /is not valid JSON/);

  path = writeOutput(projectRoot, { branches: [{ ...structuralBranch(), test_metadata: undefined }] });
  assert.throws(() => readHostSuiteOutputs(path, request), /missing test_metadata/);

  path = writeOutput(projectRoot, { branches: [{ ...structuralBranch(), runner_manifest: undefined }] });
  assert.throws(() => readHostSuiteOutputs(path, request), /missing runner_manifest/);

  path = writeOutput(projectRoot, { branches: [{ ...structuralBranch(), suite_kind: 'mystery' }] });
  assert.throws(() => readHostSuiteOutputs(path, request), /unknown suite_kind/);
});

test('rejects the legacy spec_rb shape per branch', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const path = writeOutput(projectRoot, { branches: [{ suite_kind: 'structural', spec_rb: "require 'x'\n" }] });

  assert.throws(() => readHostSuiteOutputs(path, readSuiteBuildRequest(projectRoot)), /legacy spec_rb shape/);
});

test('rejects unsafe file paths under each branch root', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const request = readSuiteBuildRequest(projectRoot);

  for (const unsafe of ['/etc/passwd', 'spec/pwned_spec.rb', '.unitbob/structural/../../pwned.rb']) {
    const branch = structuralBranch();
    (branch.suite_file as Record<string, unknown>).path = unsafe;
    const path = writeOutput(projectRoot, { branches: [branch] });
    assert.throws(() => readHostSuiteOutputs(path, request), /relative path under/, unsafe);
  }
});

test('recipeNameFor maps each kind to its generation recipe', () => {
  const structural: SuitePacket = { suite_kind: 'structural', source_digest: 'm', path_root: '.unitbob/structural/', assignment: {} };
  const behavioral: SuitePacket = { suite_kind: 'behavioral', source_digest: 's', path_root: '.unitbob/behavioral/', assignment: {} };
  assert.equal(recipeNameFor(structural), 'generate');
  assert.equal(recipeNameFor(behavioral), 'generate_behavioral');
});

test('readSuiteBuildRequest errors with guidance when the task is missing', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-no-task-'));
  assert.throws(() => readSuiteBuildRequest(projectRoot), /run `npx unitbob suite-prepare` first/);
});

test('shares a golden behavioral review candidate digest with the server', () => {
  assert.equal(
    suiteCandidateDigest(behavioralBranch()),
    '21190d11f9124c4d64f6373dcc40abcc03f0c1aec872ebf9ef5dd682ca8836ee',
  );
});
