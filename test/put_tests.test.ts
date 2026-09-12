// `put-tests <feature_id>` (spec 52-3, AC 3.5): the answer read with its files
// from disk, the connector's own run of the feature's tag as the proof of red,
// the upload, and the server's words on either outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { putTests } from '../src/verbs/putTests.ts';
import { featureFeaturePath, featureStepsPath, testsOutputPath, testsRequestPath, type TestsRequest } from '../src/files/features.ts';
import { suiteCandidateDigest } from '../src/files/suiteBuild.ts';
import type { RunnerResult } from '../src/runner/types.ts';
import { WireError } from '../src/wire.ts';
import type { Config } from '../src/config.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-put-tests-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, token: 'secret', projectRoot };
}

const MANIFEST = { language: 'ruby', framework: 'cucumber', result_format: 'cucumber_messages', runner: 'cucumber', package_manager: 'bundler', runner_version: '9.2.0' };

function prepared(projectRoot: string): { suite_file: { path: string; content: string; support_files: { path: string; content: string }[] } } {
  const request: TestsRequest = {
    project_root: projectRoot,
    recipe: { name: 'feature_tests', version: 'v', text: 't' },
    feature: { feature_id: 12, title: 'Refunds', status: 'knowledge' },
    feature_tag: 'unitbob_feature_12',
    assignment: { capabilities: [] },
    scenarios: [],
    knowledge_path: join(projectRoot, '.unitbob/features/12/knowledge.md'),
    knowledge_digest: 'kdigest',
    runner: 'cucumber',
    runner_manifest: MANIFEST,
    main_suite: 'not_built',
    feature_path: featureFeaturePath(12),
    steps_path: featureStepsPath(12, 'cucumber'),
    output_path: testsOutputPath(projectRoot, 12),
  };
  write(testsRequestPath(projectRoot, 12), JSON.stringify(request));
  write(join(projectRoot, featureFeaturePath(12)), 'Feature: Refunds\n');
  write(join(projectRoot, featureStepsPath(12, 'cucumber')), "Given('a paid order') { }\n");
  write(testsOutputPath(projectRoot, 12), JSON.stringify({
    suite_file: { path: featureFeaturePath(12), support_files: [{ path: featureStepsPath(12, 'cucumber') }] },
    runner_manifest: MANIFEST,
    test_metadata: { capabilities: [{ capability_id: 'feature_12', status: 'covered' }] },
  }));
  return {
    suite_file: {
      path: featureFeaturePath(12), content: 'Feature: Refunds\n',
      support_files: [{ path: featureStepsPath(12, 'cucumber'), content: "Given('a paid order') { }\n" }],
    },
  };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function runnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    code: 1, stdout: '1 scenario (1 failed)', stderr: '', timedOut: false,
    command: 'bundle', args: ['exec', 'cucumber'], resultPath: '.unitbob/behavioral/cucumber_messages.ndjson',
    report: '{"testCaseStarted":{"id":"1"}}\n',
    ...overrides,
  } as RunnerResult;
}

type Deps = NonNullable<Parameters<typeof putTests>[2]>;

test('put-tests runs the feature’s tag itself, attaches the red run, uploads, and prints the sentence and the link', async () => {
  const projectRoot = tmpProject();
  const { suite_file } = prepared(projectRoot);
  const out: string[] = [];
  let ran: unknown = null;
  let sent: unknown = null;

  const code = await putTests(config(projectRoot), ['12'], {
    runBehavioral: async (_root, runner, mainPath, filter) => { ran = [runner, mainPath, filter]; return runnerResult(); },
    gitRevision: () => 'abc123-dirty',
    putFeatureSuite: async (id, upload) => { sent = [id, upload]; return { suite_digest: 'sd', url: '/repos/3/features/12', message: 'Checks written for “Refunds”: 1 scenario, all red, waiting for the code.' }; },
    stdout: { write: (c: string) => { out.push(c); return true; } },
  });

  assert.equal(code, 0);
  assert.deepEqual(ran, ['cucumber', featureFeaturePath(12), { only: 'unitbob_feature_12' }]);
  const [id, upload] = sent as [number, Record<string, unknown>];
  assert.equal(id, 12);
  assert.deepEqual(upload.suite_file, suite_file);
  assert.deepEqual(upload.runner_manifest, MANIFEST);
  assert.equal(upload.knowledge_digest, 'kdigest');
  const metadata = upload.test_metadata as Record<string, unknown>;
  assert.deepEqual(metadata.capabilities, [{ capability_id: 'feature_12', status: 'covered' }]);
  assert.deepEqual(metadata.red_run, {
    candidate_digest: suiteCandidateDigest({ suite_kind: 'behavioral', suite_file, runner_manifest: MANIFEST }),
    revision: 'abc123-dirty',
    run_result: '{"testCaseStarted":{"id":"1"}}\n',
  });
  assert.equal(out.join(''), 'Checks written for “Refunds”: 1 scenario, all red, waiting for the code.\nhttps://host/repos/3/enter?next=%2Frepos%2F3%2Ffeatures%2F12#t=secret\n');
});

test('put-tests sends nothing when the runner could not start, prints what it said, and exits non-zero', async () => {
  const projectRoot = tmpProject();
  prepared(projectRoot);
  const out: string[] = [];
  let sent = false;

  const code = await putTests(config(projectRoot), ['12'], {
    runBehavioral: async () => { throw new Error('Behavioral runner missing (Cucumber). Run suite-prepare to provision it.'); },
    gitRevision: () => 'abc',
    putFeatureSuite: async () => { sent = true; return { suite_digest: '', url: '', message: '' }; },
    stdout: { write: (c: string) => { out.push(c); return true; } },
  });

  assert.equal(code, 1);
  assert.equal(sent, false);
  assert.match(out.join(''), /The runner could not start: Behavioral runner missing \(Cucumber\)/);
});

test('put-tests sends nothing when the run produced no report', async () => {
  const projectRoot = tmpProject();
  prepared(projectRoot);
  const out: string[] = [];
  let sent = false;

  const code = await putTests(config(projectRoot), ['12'], {
    runBehavioral: async () => runnerResult({ report: '', code: 2, stderr: 'NameError: uninitialized constant' }),
    gitRevision: () => 'abc',
    putFeatureSuite: async () => { sent = true; return { suite_digest: '', url: '', message: '' }; },
    stdout: { write: (c: string) => { out.push(c); return true; } },
  });

  assert.equal(code, 1);
  assert.equal(sent, false);
  assert.match(out.join(''), /produced no machine-readable report/);
  assert.match(out.join(''), /NameError: uninitialized constant/);
});

test('put-tests lets a 409 and a 422 through in the server’s words', async () => {
  const projectRoot = tmpProject();
  prepared(projectRoot);
  const refusal = new WireError('PUT suite failed: 422 — The scenarios are sealed; to change them, talk the feature through again.\nexpected: Scenario "Two" from knowledge.md\n     got: no such scenario in the .feature');

  await assert.rejects(
    () => putTests(config(projectRoot), ['12'], {
      runBehavioral: async () => runnerResult(),
      gitRevision: () => 'abc',
      putFeatureSuite: async () => { throw refusal; },
      stdout: { write: () => true },
    }),
    (err: unknown) => err === refusal,
  );
});

test('put-tests needs the feature id, the request and the answer', async () => {
  const projectRoot = tmpProject();
  await assert.rejects(() => putTests(config(projectRoot), []), /Usage: unitbob put-tests <feature_id>/);
  await assert.rejects(() => putTests(config(projectRoot), ['12']), /tests-request\.json not found/);
});
