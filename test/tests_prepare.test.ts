// `tests-prepare <feature_id>` (spec 52-3, AC 3.4): the packet and the recipe
// from the server, the knowledge file on disk held to the server's digest,
// the union of the main suite and every feature's checks on disk, the runner
// provisioned, and the host's task written beside the talk's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testsPrepare } from '../src/verbs/testsPrepare.ts';
import { knowledgePath, testsOutputPath, testsRequestPath } from '../src/files/features.ts';
import { ToolchainUnavailableError } from '../src/runner/toolchain.ts';
import { WireError, type SuiteIndex, type TestsPacket } from '../src/wire.ts';
import type { Config } from '../src/config.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-tests-prepare-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, token: 'secret', projectRoot };
}

const KNOWLEDGE = '# Refunds\n\n## Intent\n\nrefunds\n';
const KNOWLEDGE_DIGEST = createHash('sha256').update(KNOWLEDGE).digest('hex');

function packet(over: Partial<TestsPacket> = {}): TestsPacket {
  return {
    suite_kind: 'behavioral',
    source_digest: KNOWLEDGE_DIGEST,
    path_root: '.unitbob/behavioral/',
    runner_manifests: [
      { language: 'ruby', framework: 'cucumber', result_format: 'cucumber_messages', runner: 'cucumber', package_manager: 'bundler' },
      { language: 'python', framework: 'pytest-bdd', result_format: 'pytest_bdd_json', runner: 'pytest-bdd', package_manager: 'pip' },
    ],
    assignment: { capabilities: [{ capability_id: 'feature_12', contract_key: 'contract:feature_12', case_marker: 'ubc_0123456789ab' }] },
    feature: { feature_id: 12, title: 'Refunds', status: 'knowledge' },
    feature_tag: 'unitbob_feature_12',
    knowledge: KNOWLEDGE,
    knowledge_digest: KNOWLEDGE_DIGEST,
    scenarios: [{ name: 'A buyer asks for a refund', steps: [{ keyword: 'Given', text: 'a paid order' }], source: 'confirmed' }],
    main_suite: 'not_built',
    ...over,
  };
}

function index(over: Partial<SuiteIndex> = {}): SuiteIndex {
  return { suites: [{ suite_kind: 'structural', status: 'not_built' }, { suite_kind: 'behavioral', status: 'not_built' }], feature_suites: [], ...over };
}

function writeKnowledge(projectRoot: string, text = KNOWLEDGE): void {
  const path = knowledgePath(projectRoot, 12);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

type Deps = NonNullable<Parameters<typeof testsPrepare>[2]>;

function deps(over: Partial<Deps> = {}): Partial<Deps> {
  return {
    getTestsPacket: async () => packet(),
    getRecipe: async (name) => ({ name, version: 'v1', text: 'Write the checks.' }),
    getSuiteIndex: async () => index(),
    detectRunner: () => 'cucumber',
    ensureRunner: async () => ({ status: 'provisioned' }),
    installedVersion: () => '9.2.0',
    stdout: { write: () => true },
    ...over,
  };
}

test('tests-prepare writes the request with the packet, the recipe, the runner and the paths, and says where', async () => {
  const projectRoot = tmpProject();
  writeKnowledge(projectRoot);
  const out: string[] = [];

  await testsPrepare(config(projectRoot), ['12'], deps({ stdout: { write: (c: string) => { out.push(c); return true; } } }));

  const request = JSON.parse(readFileSync(testsRequestPath(projectRoot, 12), 'utf8'));
  assert.equal(request.project_root, projectRoot);
  assert.deepEqual(request.recipe, { name: 'feature_tests', version: 'v1', text: 'Write the checks.' });
  assert.deepEqual(request.feature, { feature_id: 12, title: 'Refunds', status: 'knowledge' });
  assert.equal(request.feature_tag, 'unitbob_feature_12');
  assert.deepEqual(request.assignment, packet().assignment);
  assert.deepEqual(request.scenarios, packet().scenarios);
  assert.equal(request.knowledge_path, knowledgePath(projectRoot, 12));
  assert.equal(request.knowledge_digest, KNOWLEDGE_DIGEST);
  assert.equal(request.runner, 'cucumber');
  assert.deepEqual(request.runner_manifest, {
    language: 'ruby', framework: 'cucumber', result_format: 'cucumber_messages', runner: 'cucumber', package_manager: 'bundler', runner_version: '9.2.0',
  });
  assert.equal(request.main_suite, 'not_built');
  assert.equal(request.feature_path, '.unitbob/behavioral/features/feature_12.feature');
  assert.equal(request.steps_path, '.unitbob/behavioral/step_definitions/feature_12_steps.rb');
  assert.equal(request.output_path, testsOutputPath(projectRoot, 12));
  assert.match(out.join(''), /Tests request written to .*tests-request\.json/);
});

test('tests-prepare takes the runner of the main suite when it is built, and detects one otherwise', async () => {
  const projectRoot = tmpProject();
  writeKnowledge(projectRoot);
  let detected = false;

  await testsPrepare(config(projectRoot), ['12'], deps({
    getTestsPacket: async () => packet({ main_suite: { suite_digest: 'm', runner: 'pytest-bdd', paths: ['.unitbob/behavioral/features/x.feature'] } }),
    detectRunner: () => { detected = true; return 'cucumber'; },
  }));

  const request = JSON.parse(readFileSync(testsRequestPath(projectRoot, 12), 'utf8'));
  assert.equal(request.runner, 'pytest-bdd');
  assert.equal(request.steps_path, '.unitbob/behavioral/step_definitions/test_feature_12_steps.py');
  assert.equal(detected, false);
});

test('tests-prepare stops when knowledge.md on disk differs from what the server has', async () => {
  const projectRoot = tmpProject();
  writeKnowledge(projectRoot, '# Refunds\n\n## Intent\n\nedited after the talk\n');

  await assert.rejects(
    () => testsPrepare(config(projectRoot), ['12'], deps()),
    /knowledge\.md on disk differs from what the server has — run put-knowledge first[\s\S]*expected: [0-9a-f]{64}\n     got: [0-9a-f]{64}/,
  );
  assert.ok(!existsSync(testsRequestPath(projectRoot, 12)));
});

test('tests-prepare stops when knowledge.md is not on disk at all', async () => {
  await assert.rejects(() => testsPrepare(config(tmpProject()), ['12'], deps()), /No knowledge file at/);
});

test('tests-prepare lets the server’s 409 through in its own words, before touching the disk', async () => {
  const projectRoot = tmpProject();
  await assert.rejects(
    () => testsPrepare(config(projectRoot), ['12'], deps({
      getTestsPacket: async () => { throw new WireError('GET tests_packet failed: 409 — Talk the feature through first — the checks are written from knowledge.md.'); },
    })),
    (err: unknown) => err instanceof WireError && /Talk the feature through first/.test((err as Error).message),
  );
  assert.ok(!existsSync(testsRequestPath(projectRoot, 12)));
});

test('tests-prepare materializes the union of the main suite and every feature’s checks, and the World', async () => {
  const projectRoot = tmpProject();
  writeKnowledge(projectRoot);
  const main = { path: '.unitbob/behavioral/features/surface_contracts.feature', content: 'Feature: main\n', support_files: [{ path: '.unitbob/behavioral/step_definitions/surface_steps.rb', content: '# s\n' }] };
  const other = { path: '.unitbob/behavioral/features/feature_15.feature', content: 'Feature: 15\n', support_files: [{ path: '.unitbob/behavioral/step_definitions/feature_15_steps.rb', content: '# 15\n' }] };

  await testsPrepare(config(projectRoot), ['12'], deps({
    getTestsPacket: async () => packet({ main_suite: { suite_digest: 'm', runner: 'cucumber', paths: [main.path, main.support_files[0].path] } }),
    getSuiteIndex: async () => index({
      suites: [{ suite_kind: 'behavioral', status: 'ready', suite_digest: 'm', suite_file: main, runner_manifest: { runner: 'cucumber' } }],
      feature_suites: [{ feature_id: 15, feature_tag: 'unitbob_feature_15', suite_digest: 'f', suite_file: other, runner_manifest: { runner: 'cucumber' } }],
    }),
  }));

  assert.equal(readFileSync(join(projectRoot, main.path), 'utf8'), 'Feature: main\n');
  assert.equal(readFileSync(join(projectRoot, other.path), 'utf8'), 'Feature: 15\n');
  assert.ok(existsSync(join(projectRoot, '.unitbob/behavioral/step_definitions/00_unitbob_world.rb')));
});

test('tests-prepare provisions the runner and stops on a fixable blocker with the checklist', async () => {
  const projectRoot = tmpProject();
  writeKnowledge(projectRoot);
  const provisioned: string[] = [];

  await testsPrepare(config(projectRoot), ['12'], deps({ ensureRunner: async (_root, runner) => { provisioned.push(runner); return { status: 'provisioned' }; } }));
  assert.deepEqual(provisioned, ['cucumber']);

  await assert.rejects(
    () => testsPrepare(config(projectRoot), ['12'], deps({
      ensureRunner: async () => ({ status: 'fixable', message: 'bundler is not installed', checklist: ['install bundler'] }),
    })),
    (err: unknown) => err instanceof ToolchainUnavailableError && /bundler is not installed[\s\S]*install bundler/.test((err as Error).message),
  );
});

test('tests-prepare stops when no supported runner can be found or its version read', async () => {
  const projectRoot = tmpProject();
  writeKnowledge(projectRoot);

  await assert.rejects(() => testsPrepare(config(projectRoot), ['12'], deps({ detectRunner: () => null })), /no BDD runner/i);
  await assert.rejects(() => testsPrepare(config(projectRoot), ['12'], deps({ installedVersion: () => null })), /version of "cucumber"/);
});

test('tests-prepare needs a numeric feature id', async () => {
  await assert.rejects(() => testsPrepare(config(tmpProject()), [], deps()), /Usage: unitbob tests-prepare <feature_id>/);
});
