import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputPath, writeSuiteBuildRequest, type SuiteBuildBranch } from '../src/files/suiteBuild.ts';
import { putSuiteBuild } from '../src/verbs/putSuiteBuild.ts';
import type { Config } from '../src/config.ts';
import type { SuiteBuildItem, SuiteBuildResult } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-put-suite-build-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

function branches(): SuiteBuildBranch[] {
  return [
    {
      suite_kind: 'structural', source_digest: 'map-d', path_root: '.unitbob/structural/',
      recipe: { name: 'generate', version: 'g1', text: 'g' }, assignment: {},
    },
    {
      suite_kind: 'behavioral', source_digest: 'surface-d', path_root: '.unitbob/behavioral/',
      recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' }, assignment: {},
    },
  ];
}

function writeTask(projectRoot: string): void {
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeSuiteBuildRequest(projectRoot, branches());
}

function structuralBranch(): Record<string, unknown> {
  return {
    suite_kind: 'structural',
    suite_file: {
      path: '.unitbob/structural/architecture_map_contracts_spec.rb',
      content: "require_relative 'unitbob_helper'\n\nRSpec.describe 'x' do\nend\n",
    },
    runner_manifest: { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' },
    test_metadata: { capabilities: [{ interface_id: 'billing_charge', status: 'unguarded', reason: 'no boundary' }] },
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
    test_metadata: { capabilities: [{ capability_id: 'checkout', status: 'unguarded', reason: 'needs a live provider' }] },
  };
}

const okResults: SuiteBuildResult[] = [
  { suite_kind: 'structural', status: 'created', suite_digest: 's', counts: { covered: 1 } },
  { suite_kind: 'behavioral', status: 'created', suite_digest: 'b', counts: { covered: 1 } },
];

test('put-suite-build uploads both branches, echoing each source_digest from the task', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [structuralBranch(), behavioralBranch()] }));

  let uploaded: SuiteBuildItem[] = [];
  await putSuiteBuild(config(projectRoot), [], {
    putSuiteBuilds: async (items) => { uploaded = items; return okResults; },
    stdout: { write: () => true },
  });

  assert.deepEqual(uploaded.map((item) => item.suite_kind), ['structural', 'behavioral']);
  assert.equal(uploaded[0].source_digest, 'map-d');
  assert.equal(uploaded[1].source_digest, 'surface-d');
  assert.deepEqual(uploaded[0].artifacts!.runner_manifest, structuralBranch().runner_manifest);
  assert.deepEqual(
    (uploaded[1].artifacts!.suite_file as Record<string, unknown>).support_files,
    (behavioralBranch().suite_file as Record<string, unknown>).support_files,
  );
});

test('put-suite-build relays a per-branch build_error without rolling back the peer', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  writeFileSync(
    outputPath(projectRoot),
    JSON.stringify({
      branches: [structuralBranch(), { suite_kind: 'behavioral', build_error: { message: 'cucumber is not installable here' } }],
    }),
  );

  let uploaded: SuiteBuildItem[] = [];
  await putSuiteBuild(config(projectRoot), [], {
    putSuiteBuilds: async (items) => { uploaded = items; return okResults; },
    stdout: { write: () => true },
  });

  assert.equal(uploaded[0].artifacts !== undefined, true);
  assert.equal(uploaded[1].build_error?.message, 'cucumber is not installable here');
  assert.equal(uploaded[1].source_digest, 'surface-d');
});

test('put-suite-build refuses to upload when the host output is unparseable', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  writeFileSync(outputPath(projectRoot), 'sorry, here are your tests:');

  let uploaded = false;
  await assert.rejects(
    () =>
      putSuiteBuild(config(projectRoot), [], {
        putSuiteBuilds: async () => { uploaded = true; throw new Error('should not upload'); },
        stdout: { write: () => true },
      }),
    /is not valid JSON/,
  );
  assert.equal(uploaded, false);
});

test('put-suite-build rejects a behavioral branch whose file escapes the behavioral root', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const escaped = behavioralBranch();
  (escaped.suite_file as Record<string, unknown>).path = 'features/pwned.feature';
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [structuralBranch(), escaped] }));

  let uploaded = false;
  await assert.rejects(
    () =>
      putSuiteBuild(config(projectRoot), [], {
        putSuiteBuilds: async () => { uploaded = true; throw new Error('should not upload'); },
        stdout: { write: () => true },
      }),
    /\.unitbob\/behavioral\//,
  );
  assert.equal(uploaded, false);
});

test('put-suite-build rejects the legacy spec_rb shape', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  writeFileSync(
    outputPath(projectRoot),
    JSON.stringify({ branches: [{ suite_kind: 'structural', spec_rb: "require 'rails_helper'\n" }] }),
  );

  await assert.rejects(
    () => putSuiteBuild(config(projectRoot), [], { putSuiteBuilds: async () => okResults, stdout: { write: () => true } }),
    /legacy spec_rb/,
  );
});
