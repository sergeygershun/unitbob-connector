import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { filesLostOnMaterialize } from '../src/files/behavioral.ts';
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

test('takes a file the host already wrote when the branch names it without content', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral', 'features'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral', 'step_definitions'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.unitbob', 'behavioral', 'features', 'surface_contracts.feature'),
    'Feature: from disk\n',
  );
  writeFileSync(
    join(projectRoot, '.unitbob', 'behavioral', 'step_definitions', 'client_management_steps.rb'),
    '# client steps\n',
  );

  const branch = behavioralBranch();
  branch.suite_file = {
    path: '.unitbob/behavioral/features/surface_contracts.feature',
    support_files: [{ path: '.unitbob/behavioral/step_definitions/client_management_steps.rb' }],
  };
  const path = writeOutput(projectRoot, { branches: [branch] });

  const [behavioral] = readHostSuiteOutputs(path, readSuiteBuildRequest(projectRoot));
  const envelope = behavioral.suite_file as { content: string; support_files: { content: string }[] };
  assert.equal(envelope.content, 'Feature: from disk\n');
  assert.equal(envelope.support_files[0].content, '# client steps\n');
});

test('rejects a named file the host never wrote, and empty content', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const request = readSuiteBuildRequest(projectRoot);

  const missing = behavioralBranch();
  missing.suite_file = { path: '.unitbob/behavioral/features/surface_contracts.feature' };
  assert.throws(
    () => readHostSuiteOutputs(writeOutput(projectRoot, { branches: [missing] }), request),
    /no such file exists/,
  );

  const blank = structuralBranch();
  (blank.suite_file as Record<string, unknown>).content = '   ';
  assert.throws(
    () => readHostSuiteOutputs(writeOutput(projectRoot, { branches: [blank] }), request),
    /empty content/,
  );
});

test('refuses a suite file that is a link out of the suite root', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const secret = join(projectRoot, 'private_key');
  writeFileSync(secret, 'ssh-rsa AAAA\n');
  mkdirSync(join(projectRoot, '.unitbob', 'structural'), { recursive: true });
  symlinkSync(secret, join(projectRoot, '.unitbob', 'structural', 'architecture_map_contracts_spec.rb'));

  const branch = structuralBranch();
  branch.suite_file = { path: '.unitbob/structural/architecture_map_contracts_spec.rb' };
  const path = writeOutput(projectRoot, { branches: [branch] });

  assert.throws(() => readHostSuiteOutputs(path, readSuiteBuildRequest(projectRoot)), /resolves outside the suite root/);
});

// A leaf-only symlink check passes this: the file is real, the directory holding
// it is the link.
test('refuses a suite file whose directory is a link out of the suite root', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const outside = join(projectRoot, 'elsewhere');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'architecture_map_contracts_spec.rb'), '# not ours\n');
  mkdirSync(join(projectRoot, '.unitbob'), { recursive: true });
  symlinkSync(outside, join(projectRoot, '.unitbob', 'structural'));

  const branch = structuralBranch();
  branch.suite_file = { path: '.unitbob/structural/architecture_map_contracts_spec.rb' };
  const path = writeOutput(projectRoot, { branches: [branch] });

  assert.throws(() => readHostSuiteOutputs(path, readSuiteBuildRequest(projectRoot)), /resolves outside the suite root/);
});

test('names the files the next materialization would delete', () => {
  const projectRoot = tmpProject();
  const steps = join(projectRoot, '.unitbob', 'behavioral', 'step_definitions');
  const support = join(projectRoot, '.unitbob', 'behavioral', 'features', 'support');
  mkdirSync(steps, { recursive: true });
  mkdirSync(support, { recursive: true });
  writeFileSync(join(projectRoot, '.unitbob', 'behavioral', 'features', 'surface_contracts.feature'), 'Feature: x\n');
  writeFileSync(join(steps, 'client_management_steps.rb'), '# listed\n');
  writeFileSync(join(steps, 'billing_steps.rb'), '# forgotten\n');
  // The directory the answer never mentions at all — the case a scan of only the
  // listed directories misses, and the conventional home of a Cucumber helper.
  writeFileSync(join(support, 'env.rb'), '# forgotten too\n');
  // The separately provisioned runner environment is not the answer's to list.
  writeFileSync(join(projectRoot, '.unitbob', 'behavioral', 'Gemfile'), "source 'x'\n");

  const lost = filesLostOnMaterialize(projectRoot, {
    path: '.unitbob/behavioral/features/surface_contracts.feature',
    content: 'Feature: x\n',
    support_files: [{ path: '.unitbob/behavioral/step_definitions/client_management_steps.rb', content: '# listed\n' }],
  }, 'cucumber');

  assert.deepEqual(lost, [
    '.unitbob/behavioral/features/support/env.rb',
    '.unitbob/behavioral/step_definitions/billing_steps.rb',
  ]);
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
