// `put-tests <feature_id>` (spec 52-3, AC 3.5): the answer read with its files
// from disk, the connector's own run of the feature's tag as the proof of red,
// the upload, and the server's words on either outcome. Since spec 52-4 (AC
// 1.10) the same run decides which proof travels — the red run, the
// reviewer's file, or none — and is filed under the new version afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { putTests } from '../src/verbs/putTests.ts';
import { featureFeaturePath, featureStepsPath, testsOutputPath, testsRequestPath, testsReviewOutputPath, type TestsRequest } from '../src/files/features.ts';
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

const KNOWLEDGE = '# Refunds\n';
const KNOWLEDGE_DIGEST = createHash('sha256').update(KNOWLEDGE).digest('hex');

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
    knowledge_digest: KNOWLEDGE_DIGEST,
    runner: 'cucumber',
    runner_manifest: MANIFEST,
    main_suite: 'not_built',
    feature_path: featureFeaturePath(12),
    steps_path: featureStepsPath(12, 'cucumber'),
    output_path: testsOutputPath(projectRoot, 12),
  };
  write(testsRequestPath(projectRoot, 12), JSON.stringify(request));
  write(join(projectRoot, '.unitbob/features/12/knowledge.md'), KNOWLEDGE);
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

// A cucumber report with one scenario per status given, as the runner writes it.
function cucumberReport(statuses: ('PASSED' | 'FAILED')[]): string {
  return statuses.flatMap((status, index) => [
    { pickle: { id: `p${index}`, name: `Scenario ${index}`, uri: 'features/feature_12.feature', tags: [{ name: '@unitbob_feature_12' }] } },
    { testCase: { id: `tc${index}`, pickleId: `p${index}`, testSteps: [{ id: `s${index}` }] } },
    { testCaseStarted: { id: `run${index}`, testCaseId: `tc${index}` } },
    { testStepFinished: { testCaseStartedId: `run${index}`, testStepId: `s${index}`, testStepResult: { status, message: status === 'FAILED' ? 'not yet' : '' } } },
  ]).map((line) => JSON.stringify(line)).join('\n') + '\n';
}

const ALL_RED = cucumberReport(['FAILED', 'FAILED']);
const MIXED = cucumberReport(['PASSED', 'FAILED']);
const ALL_GREEN = cucumberReport(['PASSED', 'PASSED']);

function runnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    code: 1, stdout: '2 scenarios (2 failed)', stderr: '', timedOut: false,
    command: 'bundle', args: ['exec', 'cucumber'], resultPath: '.unitbob/behavioral/cucumber_messages.ndjson',
    report: ALL_RED,
    ...overrides,
  } as RunnerResult;
}

type Deps = NonNullable<Parameters<typeof putTests>[2]>;

const CANDIDATE_DIGEST = suiteCandidateDigest({
  suite_kind: 'behavioral',
  suite_file: {
    path: featureFeaturePath(12), content: 'Feature: Refunds\n',
    support_files: [{ path: featureStepsPath(12, 'cucumber'), content: "Given('a paid order') { }\n" }],
  },
  runner_manifest: MANIFEST,
});

const REVIEW = {
  scenario_reviews: [
    { scenario: 'Scenario 0', case_marker: 'ubc_0123456789ab', verdict: 'pass', public_surfaces: ['POST /refunds'], given_then_evidence: 'e', outcome: 'o', outcome_kind: 'specific' },
    { scenario: 'Scenario 1', case_marker: 'ubc_0123456789ab', verdict: 'pass', public_surfaces: ['POST /refunds'], given_then_evidence: 'e', outcome: 'o', outcome_kind: 'specific' },
  ],
};

function writeReview(projectRoot: string, candidateDigest = CANDIDATE_DIGEST): void {
  write(testsReviewOutputPath(projectRoot, 12), JSON.stringify({ candidate_digest: candidateDigest, bdd_quality_review: REVIEW }));
}

// The upload accepted and the run filed under the new version: what a test
// that does not care about either sees.
function accepted(over: Partial<Deps> = {}): Partial<Deps> {
  return {
    runBehavioral: async () => runnerResult(),
    gitRevision: () => 'abc',
    putFeatureSuite: async () => ({ suite_digest: 'sd-new', url: '/repos/3/features/12', message: 'Checks saved.' }),
    postRunsBatch: async () => ({ results: [{ suite_kind: 'behavioral', feature_id: 12, suite_digest: 'sd-new', status: 'failed', summary: 'Refunds: 0 of 2 checks pass.', lamps: null }], map_url: '' }),
    stdout: { write: () => true },
    ...over,
  };
}

test('put-tests runs the feature’s tag itself, attaches the red run, uploads, files the run, and prints the sentences and the link', async () => {
  const projectRoot = tmpProject();
  const { suite_file } = prepared(projectRoot);
  const out: string[] = [];
  let ran: unknown = null;
  let sent: unknown = null;
  let filed: unknown = null;

  const code = await putTests(config(projectRoot), ['12'], accepted({
    runBehavioral: async (_root, runner, mainPath, filter) => { ran = [runner, mainPath, filter]; return runnerResult(); },
    gitRevision: () => 'abc123-dirty',
    putFeatureSuite: async (id, upload) => { sent = [id, upload]; return { suite_digest: 'sd-new', url: '/repos/3/features/12', message: 'Checks written for “Refunds”: 2 scenarios, all red, waiting for the code.' }; },
    postRunsBatch: async (runs) => { filed = runs; return { results: [{ suite_kind: 'behavioral', feature_id: 12, suite_digest: 'sd-new', status: 'failed', summary: 'Refunds: 0 of 2 checks pass.', lamps: null }], map_url: '' }; },
    stdout: { write: (c: string) => { out.push(c); return true; } },
  }));

  assert.equal(code, 0);
  assert.deepEqual(ran, ['cucumber', featureFeaturePath(12), { only: 'unitbob_feature_12' }]);
  const [id, upload] = sent as [number, Record<string, unknown>];
  assert.equal(id, 12);
  assert.deepEqual(upload.suite_file, suite_file);
  assert.deepEqual(upload.runner_manifest, MANIFEST);
  assert.equal(upload.knowledge_digest, KNOWLEDGE_DIGEST);
  const metadata = upload.test_metadata as Record<string, unknown>;
  assert.deepEqual(metadata.capabilities, [{ capability_id: 'feature_12', status: 'covered' }]);
  assert.deepEqual(metadata.red_run, { candidate_digest: CANDIDATE_DIGEST, revision: 'abc123-dirty', run_result: ALL_RED });
  assert.equal('bdd_quality_review' in metadata, false);
  // The same run, filed under the version the server just minted (spec 52-4,
  // AC 1.10), so the page shows "N of M" on it at once.
  assert.deepEqual(filed, [{ suite_digest: 'sd-new', run_result: ALL_RED }]);
  assert.equal(
    out.join(''),
    'Checks written for “Refunds”: 2 scenarios, all red, waiting for the code.\n' +
      'Refunds: 0 of 2 checks pass.\n' +
      'https://host/repos/3/enter?next=%2Frepos%2F3%2Ffeatures%2F12#t=secret\n',
  );
});

// Spec 52-4, AC 1.10: the three kinds, decided by the run and the review file.
test('put-tests sends a mixed run with no proof at all', async () => {
  const projectRoot = tmpProject();
  prepared(projectRoot);
  let metadata: Record<string, unknown> = {};

  const code = await putTests(config(projectRoot), ['12'], accepted({
    runBehavioral: async () => runnerResult({ report: MIXED }),
    putFeatureSuite: async (_id, upload) => { metadata = upload.test_metadata; return { suite_digest: 'sd-new', url: '/x', message: 'Checks saved.' }; },
  }));

  assert.equal(code, 0);
  assert.deepEqual(metadata, { capabilities: [{ capability_id: 'feature_12', status: 'covered' }] });
});

test('put-tests sends an all-green run with the review beside it as the review, bound to the candidate', async () => {
  const projectRoot = tmpProject();
  prepared(projectRoot);
  writeReview(projectRoot);
  let metadata: Record<string, unknown> = {};
  const out: string[] = [];

  const code = await putTests(config(projectRoot), ['12'], accepted({
    runBehavioral: async () => runnerResult({ code: 0, report: ALL_GREEN }),
    putFeatureSuite: async (_id, upload) => { metadata = upload.test_metadata; return { suite_digest: 'sd-new', url: '/repos/3/features/12', message: 'Checks reviewed.' }; },
    postRunsBatch: async () => ({ results: [{ suite_kind: 'behavioral', feature_id: 12, suite_digest: 'sd-new', status: 'ok', summary: 'Refunds: all 2 checks pass, reviewed — press Finish on the feature page.', lamps: null }], map_url: '' }),
    stdout: { write: (c: string) => { out.push(c); return true; } },
  }));

  assert.equal(code, 0);
  assert.deepEqual(metadata, {
    capabilities: [{ capability_id: 'feature_12', status: 'covered' }],
    bdd_quality_review: { ...REVIEW, candidate_digest: CANDIDATE_DIGEST },
  });
  assert.match(out.join(''), /Checks reviewed\.\nRefunds: all 2 checks pass, reviewed — press Finish on the feature page\.\n/);
});

test('put-tests ignores a review written for an older candidate, says so, and sends the red run', async () => {
  const projectRoot = tmpProject();
  prepared(projectRoot);
  writeReview(projectRoot, 'f'.repeat(64));
  let metadata: Record<string, unknown> = {};
  const out: string[] = [];

  const code = await putTests(config(projectRoot), ['12'], accepted({
    putFeatureSuite: async (_id, upload) => { metadata = upload.test_metadata; return { suite_digest: 'sd-new', url: '/x', message: 'Checks saved.' }; },
    stdout: { write: (c: string) => { out.push(c); return true; } },
  }));

  assert.equal(code, 0);
  assert.equal('bdd_quality_review' in metadata, false);
  assert.ok('red_run' in metadata);
  assert.match(out.join(''), /tests-review-output\.json is for an older candidate — ignored/);
});

test('put-tests stops in one line on a review file it cannot read, before running or sending anything', async () => {
  const projectRoot = tmpProject();
  prepared(projectRoot);
  write(testsReviewOutputPath(projectRoot, 12), '{ not json');
  let ran = false;
  let sent = false;
  const out: string[] = [];

  const code = await putTests(config(projectRoot), ['12'], accepted({
    runBehavioral: async () => { ran = true; return runnerResult(); },
    putFeatureSuite: async () => { sent = true; return { suite_digest: '', url: '', message: '' }; },
    stdout: { write: (c: string) => { out.push(c); return true; } },
  }));

  assert.equal(code, 1);
  assert.equal(ran, false);
  assert.equal(sent, false);
  assert.equal(out.length, 2);
  assert.match(out[0], /^.*tests-review-output\.json is not valid JSON \(.*\)\n$/);
  assert.equal(out[1], 'Nothing was sent.\n');
});

test('put-tests refuses to send a review over a run that is not all green, and sends nothing', async () => {
  const projectRoot = tmpProject();
  prepared(projectRoot);
  writeReview(projectRoot);
  let sent = false;
  let filed = false;
  const out: string[] = [];

  const code = await putTests(config(projectRoot), ['12'], accepted({
    runBehavioral: async () => runnerResult({ report: cucumberReport(['PASSED', 'PASSED', 'PASSED', 'FAILED', 'FAILED']) }),
    putFeatureSuite: async () => { sent = true; return { suite_digest: '', url: '', message: '' }; },
    postRunsBatch: async () => { filed = true; return { results: [], map_url: '' }; },
    stdout: { write: (c: string) => { out.push(c); return true; } },
  }));

  assert.equal(code, 1);
  assert.equal(sent, false);
  assert.equal(filed, false);
  assert.equal(out.join(''), 'Review the checks when they all pass — 2 of 5 still fail.\n');
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
    () => putTests(config(projectRoot), ['12'], accepted({ putFeatureSuite: async () => { throw refusal; } })),
    (err: unknown) => err === refusal,
  );
});

// The upload is done by then, and the sentence saying so has been printed;
// the run that could not be filed is the next `check`'s to file.
test('put-tests says the checks were saved before a failed filing of the run stops it', async () => {
  const projectRoot = tmpProject();
  prepared(projectRoot);
  const out: string[] = [];

  await assert.rejects(
    () => putTests(config(projectRoot), ['12'], accepted({
      postRunsBatch: async () => { throw new WireError('POST runs/batch failed: 500'); },
      stdout: { write: (c: string) => { out.push(c); return true; } },
    })),
    /runs\/batch failed: 500/,
  );
  assert.equal(out.join(''), 'Checks saved.\n');
});

test('put-tests stops when knowledge.md changed since tests-prepare, naming both digests, and sends nothing', async () => {
  const projectRoot = tmpProject();
  prepared(projectRoot);
  write(join(projectRoot, '.unitbob/features/12/knowledge.md'), '# Refunds, edited\n');
  let sent = false;

  await assert.rejects(
    () => putTests(config(projectRoot), ['12'], {
      runBehavioral: async () => runnerResult(),
      gitRevision: () => 'abc',
      putFeatureSuite: async () => { sent = true; return { suite_digest: '', url: '', message: '' }; },
      stdout: { write: () => true },
    }),
    (err: unknown) => /knowledge\.md on disk differs[\s\S]*expected: [0-9a-f]{64}\n     got: [0-9a-f]{64}/.test((err as Error).message),
  );
  assert.equal(sent, false);
});

test('put-tests needs the feature id, the request and the answer', async () => {
  const projectRoot = tmpProject();
  await assert.rejects(() => putTests(config(projectRoot), []), /Usage: unitbob put-tests <feature_id>/);
  await assert.rejects(() => putTests(config(projectRoot), ['12']), /tests-request\.json not found/);
});
