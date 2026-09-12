import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { run, runOnly } from '../src/verbs/run.ts';
import { FeatureFilesChangedError, materializeBehavioralUnion } from '../src/files/behavioral.ts';
import { runBddSuite } from '../src/runner/bdd.ts';
import type { Config } from '../src/config.ts';
import type { RunnerResult } from '../src/runner/types.ts';
import type { SuiteListItem } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-check-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, token: 'secret-token', projectRoot };
}

const okStack = () => ({ ok: true });

function structuralSuite(runner = 'rspec'): SuiteListItem {
  const byRunner: Record<string, { path: string; result_format: string }> = {
    rspec: { path: '.unitbob/structural/architecture_map_contracts_spec.rb', result_format: 'rspec_json' },
    vitest: { path: '.unitbob/structural/architecture_map_contracts.test.ts', result_format: 'vitest_json' },
    pytest: { path: '.unitbob/structural/test_architecture_map_contracts.py', result_format: 'junit_xml' },
  };
  const stack = byRunner[runner];
  return {
    suite_kind: 'structural',
    status: 'ready',
    suite_digest: 'struct-d1',
    suite_file: { path: stack.path, content: 'suite bytes' },
    runner_manifest: { runner, result_format: stack.result_format },
  };
}

function behavioralSuite(): SuiteListItem {
  return {
    suite_kind: 'behavioral',
    status: 'ready',
    suite_digest: 'behav-d1',
    suite_file: {
      path: '.unitbob/behavioral/features/surface_contracts.feature',
      content: 'Feature: x\n',
      support_files: [{ path: '.unitbob/behavioral/step_definitions/surface_steps.rb', content: '# steps\n' }],
    },
    runner_manifest: { runner: 'cucumber', result_format: 'cucumber_messages' },
  };
}

function runnerResult(overrides: Partial<RunnerResult>): RunnerResult {
  return {
    stdout: '', stderr: '', code: 0, command: 'runner', args: [],
    resultPath: '.unitbob/structural/rspec_result.json', report: '', ...overrides,
  };
}

type RunDeps = NonNullable<Parameters<typeof run>[2]>;

function batchDeps(over: Partial<RunDeps> = {}): Partial<RunDeps> {
  return {
    postRunsBatch: async () => ({ results: [], map_url: 'https://host/repos/3/map' }),
    materializeStructural: () => {},
    materializeBehavioral: () => ({ mainPath: '.unitbob/behavioral/features/surface_contracts.feature', excludeTags: [] }),
    runStructural: async () => runnerResult({ report: '{"examples":[]}' }),
    runBehavioral: async () => runnerResult({ report: '{"testCaseStarted":{}}\n' }),
    validateStack: okStack,
    stdout: { write: () => true },
    ...over,
  };
}

test('no ready suites prints a no-suite message and runs nothing', async () => {
  let ran = false;
  let output = '';

  await run(config(tmpProject()), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [
      { suite_kind: 'structural', status: 'not_built' },
      { suite_kind: 'behavioral', status: 'not_built' },
    ], feature_suites: [] }),
    runStructural: async () => { ran = true; return runnerResult({}); },
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  }));

  assert.equal(ran, false);
  assert.match(output, /No Unitbob suites exist yet/);
});

test('runs both peer suites and ships one batch of two run_results', async () => {
  const projectRoot = tmpProject();
  let uploaded: unknown[] = [];
  const calls: string[] = [];
  let output = '';

  await run(config(projectRoot), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [structuralSuite(), behavioralSuite()], feature_suites: [] }),
    materializeStructural: (_root, item) => { calls.push(`mat-struct:${item.suite_kind}`); },
    materializeBehavioral: (_root, index) => { calls.push(`mat-behav:${index.suites[1].suite_kind}`); return { mainPath: 'main.feature', excludeTags: [] }; },
    runStructural: async () => runnerResult({ report: '{"examples":[]}' }),
    runBehavioral: async () =>
      runnerResult({ report: '{"testCaseStarted":{}}\n', resultPath: '.unitbob/behavioral/cucumber_messages.ndjson' }),
    postRunsBatch: async (runs) => {
      uploaded = runs;
      return {
        results: [
          { suite_kind: 'structural', suite_digest: 'struct-d1', status: 'ok', summary: 'Architecture checks passed.' },
          { suite_kind: 'behavioral', suite_digest: 'behav-d1', status: 'ok', summary: 'Product behaviour checks passed.' },
        ],
        map_url: 'https://host/repos/3/map',
      };
    },
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  }));

  assert.deepEqual(calls, ['mat-struct:structural', 'mat-behav:behavioral']);
  assert.deepEqual(uploaded, [
    { suite_digest: 'struct-d1', run_result: '{"examples":[]}' },
    { suite_digest: 'behav-d1', run_result: '{"testCaseStarted":{}}\n' },
  ]);
  assert.match(output, /Architecture checks passed/);
  assert.match(output, /Product behaviour checks passed/);
  // The map link is printed through the exchanger, with the token added here at
  // the moment of printing (spec 33).
  assert.match(output, /\/repos\/3\/enter\?next=%2Frepos%2F3%2Fmap#t=secret-token/);
});

// Spec 39, criterion 3, on the published side. The shared setup file comes back
// down with the rest of the branch — it travels as a support file so that
// `materializeGuardrails` writes it back rather than wiping it — and it is the
// one support file the runner must never be pointed at.
test('the shared setup file comes back with the branch but is never run as a test', async () => {
  let given: string[] = [];

  const published = structuralSuite('vitest');
  published.suite_file!.support_files = [
    { path: '.unitbob/structural/_setup.ts', content: '// nothing to prepare here\n' },
    { path: '.unitbob/structural/reporting.test.ts', content: 'suite bytes' },
  ];

  await run(config(tmpProject()), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [published], feature_suites: [] }),
    runStructural: async (_root, _runner, suitePaths) => { given = suitePaths; return runnerResult({ report: '{}' }); },
  }));

  assert.deepEqual(given, [
    '.unitbob/structural/architecture_map_contracts.test.ts',
    '.unitbob/structural/reporting.test.ts',
  ]);
});

test('a structural stack mismatch becomes that branch suite_error; the behavioral branch still runs', async () => {
  let uploaded: Array<Record<string, unknown>> = [];
  let structuralMaterialized = false;

  await run(config(tmpProject()), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [structuralSuite('vitest'), behavioralSuite()], feature_suites: [] }),
    // Both branches route through the precheck; only the structural (vitest) one
    // fails here.
    validateStack: (_root, runner) =>
      runner === 'vitest'
        ? { ok: false, message: 'JS/TS guardrails require Vitest, which was not found.' }
        : { ok: true },
    materializeStructural: () => { structuralMaterialized = true; },
    runBehavioral: async () => runnerResult({ report: '{"testCaseStarted":{}}\n' }),
    postRunsBatch: async (runs) => { uploaded = runs as Array<Record<string, unknown>>; return { results: [], map_url: '' }; },
  }));

  assert.equal(structuralMaterialized, false);
  assert.equal(uploaded[0].suite_digest, 'struct-d1');
  assert.match(String((uploaded[0].suite_error as Record<string, unknown>).output_tail), /require Vitest/);
  // The behavioral branch passed its own precheck and still ran.
  assert.equal(uploaded[1].suite_digest, 'behav-d1');
  assert.equal('run_result' in uploaded[1], true);
});

test('a behavioral stack mismatch becomes that branch suite_error; the structural branch still runs', async () => {
  let uploaded: Array<Record<string, unknown>> = [];
  let behavioralMaterialized = false;

  await run(config(tmpProject()), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [structuralSuite(), behavioralSuite()], feature_suites: [] }),
    // Only the behavioral (cucumber) branch fails its language check.
    validateStack: (_root, runner) =>
      runner === 'cucumber'
        ? { ok: false, message: 'The behavioral (Gherkin) suite selected the Ruby stack, but this project does not look like Rails.' }
        : { ok: true },
    materializeBehavioral: () => { behavioralMaterialized = true; return { mainPath: 'main.feature', excludeTags: [] }; },
    runStructural: async () => runnerResult({ report: '{"examples":[]}' }),
    postRunsBatch: async (runs) => { uploaded = runs as Array<Record<string, unknown>>; return { results: [], map_url: '' }; },
  }));

  assert.equal(behavioralMaterialized, false);
  assert.equal(uploaded[1].suite_digest, 'behav-d1');
  assert.match(String((uploaded[1].suite_error as Record<string, unknown>).output_tail), /does not look like Rails/);
  // The structural branch passed its own precheck and still ran.
  assert.equal(uploaded[0].suite_digest, 'struct-d1');
  assert.equal('run_result' in uploaded[0], true);
});

test('a run that produced no report becomes a structured suite_error, never per-contract results', async () => {
  let uploaded: Array<Record<string, unknown>> = [];

  await run(config(tmpProject()), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [structuralSuite('vitest')], feature_suites: [] }),
    runStructural: async () =>
      runnerResult({
        stderr: "Error: Cannot find module 'vitest'", code: 1, command: 'npx',
        args: ['vitest', 'run', '.unitbob/structural/x.test.ts'],
        resultPath: '.unitbob/structural/vitest_result.json', report: '',
      }),
    postRunsBatch: async (runs) => { uploaded = runs as Array<Record<string, unknown>>; return { results: [], map_url: '' }; },
  }));

  const error = uploaded[0].suite_error as Record<string, unknown>;
  assert.equal(uploaded[0].suite_digest, 'struct-d1');
  assert.equal(error.command, 'npx vitest run .unitbob/structural/x.test.ts');
  assert.equal(error.exit_code, 1);
  assert.match(String(error.output_tail), /Cannot find module 'vitest'/);
  assert.equal('run_result' in uploaded[0], false);
});

test('a behavioral runner that produced no report becomes a suite_error without installing anything', async () => {
  let uploaded: Array<Record<string, unknown>> = [];

  await run(config(tmpProject()), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [behavioralSuite()], feature_suites: [] }),
    runBehavioral: async () =>
      runnerResult({
        stderr: 'cucumber: command not found', code: 127, command: 'bundle',
        args: ['exec', 'cucumber'], resultPath: '.unitbob/behavioral/cucumber_messages.ndjson', report: '',
      }),
    postRunsBatch: async (runs) => { uploaded = runs as Array<Record<string, unknown>>; return { results: [], map_url: '' }; },
  }));

  assert.equal(uploaded[0].suite_digest, 'behav-d1');
  assert.equal('run_result' in uploaded[0], false);
  assert.match(String((uploaded[0].suite_error as Record<string, unknown>).output_tail), /command not found/);
});

test('the public run flow preserves the provisioned behavioral sidecar while refreshing suite files', async () => {
  const projectRoot = tmpProject();
  const sidecarGemfile = join(projectRoot, '.unitbob', 'behavioral', 'Gemfile');
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral'), { recursive: true });
  writeFileSync(sidecarGemfile, 'gem "cucumber"\n');

  await run(config(projectRoot), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [behavioralSuite()], feature_suites: [] }),
    materializeBehavioral: (root, index) =>
      materializeBehavioralUnion(root, index, 'cucumber')!,
    runBehavioral: async () => {
      assert.equal(existsSync(sidecarGemfile), true);
      return runnerResult({ report: '{"testCaseStarted":{}}\n' });
    },
  }));
});

test('run default assembly preserves and uses the provisioned behavioral sidecar', async () => {
  const projectRoot = tmpProject();
  const behavioralRoot = join(projectRoot, '.unitbob', 'behavioral');
  const sidecarGemfile = join(behavioralRoot, 'Gemfile');
  const fakeBin = join(projectRoot, 'fake-bin');
  const fakeBundle = join(fakeBin, 'bundle');
  const sidecarContent = 'gem "cucumber"\n';
  let uploaded: Array<Record<string, unknown>> = [];

  mkdirSync(behavioralRoot, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(projectRoot, 'Gemfile'), 'gem "rails"\n');
  writeFileSync(sidecarGemfile, sidecarContent);
  writeFileSync(
    fakeBundle,
    '#!/bin/sh\n' +
      'test "$BUNDLE_GEMFILE" = ".unitbob/behavioral/Gemfile" || exit 41\n' +
      'test -f .unitbob/behavioral/features/surface_contracts.feature || exit 42\n' +
      'test -f .unitbob/behavioral/step_definitions/surface_steps.rb || exit 43\n' +
      'printf \'%s\\n\' \'{"testCaseStarted":{"id":"scenario-1"}}\' > .unitbob/behavioral/cucumber_messages.ndjson\n',
  );
  chmodSync(fakeBundle, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = [fakeBin, originalPath].filter(Boolean).join(delimiter);
  try {
    await run(config(projectRoot), [], {
      getSuiteIndex: async () => ({ suites: [behavioralSuite()], feature_suites: [] }),
      postRunsBatch: async (runs) => {
        uploaded = runs as Array<Record<string, unknown>>;
        return { results: [], map_url: '' };
      },
      stdout: { write: () => true },
    });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }

  assert.equal(readFileSync(sidecarGemfile, 'utf8'), sidecarContent);
  assert.deepEqual(uploaded, [
    {
      suite_digest: 'behav-d1',
      run_result: '{"testCaseStarted":{"id":"scenario-1"}}\n',
    },
  ]);
});

// --- the filtered first run inside put-suite-build (spec 32-4) ----------------
//
// `check` answers "run everything we have". The first run answers a narrower
// question: "run exactly what this command just published". The two share one
// implementation and differ only in the filter.

test('the filtered run executes only the identities it was given', async () => {
  let uploaded: Array<Record<string, unknown>> = [];

  await runOnly(config(tmpProject()), ['behav-d1'], batchDeps({
    getSuiteIndex: async () => ({ suites: [structuralSuite(), behavioralSuite()], feature_suites: [] }),
    postRunsBatch: async (runs) => { uploaded = runs as Array<Record<string, unknown>>; return { results: [], map_url: '' }; },
  }));

  assert.deepEqual(uploaded.map((entry) => entry.suite_digest), ['behav-d1']);
});

// Publication and this fetch are two requests. If something republished in
// between, the version we were told to run is gone — and running the newer one
// would file honest results against a version this user never published.
test('the filtered run refuses the whole batch when one requested identity is gone', async () => {
  let posted = false;
  let ran = false;

  await assert.rejects(
    () =>
      runOnly(config(tmpProject()), ['struct-d1', 'behav-d1'], batchDeps({
        getSuiteIndex: async () => ({ suites: [structuralSuite()], feature_suites: [] }),
        runStructural: async () => { ran = true; return runnerResult({ report: '{"examples":[]}' }); },
        postRunsBatch: async () => { posted = true; return { results: [], map_url: '' }; },
      })),
    /behav-d1[\s\S]*no longer the current one/,
  );

  assert.equal(ran, false, 'not even the identity that was still current may run');
  assert.equal(posted, false);
});

// A suite the server no longer lists as ready is just as absent as a replaced one.
test('the filtered run refuses an identity the server no longer reports as ready', async () => {
  await assert.rejects(
    () =>
      runOnly(config(tmpProject()), ['struct-d1'], batchDeps({
        getSuiteIndex: async () => ({ suites: [{ ...structuralSuite(), status: 'not_built' }], feature_suites: [] }),
        postRunsBatch: async () => { throw new Error('must not upload'); },
      })),
    /no longer the current one/,
  );
});

// The standalone flow keeps its own contract: everything ready runs, and an
// identity from some earlier suite is simply not its business.
test('the standalone run is unfiltered and still runs every ready peer', async () => {
  let uploaded: Array<Record<string, unknown>> = [];

  await run(config(tmpProject()), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [structuralSuite(), behavioralSuite()], feature_suites: [] }),
    postRunsBatch: async (runs) => { uploaded = runs as Array<Record<string, unknown>>; return { results: [], map_url: '' }; },
  }));

  assert.deepEqual(uploaded.map((entry) => entry.suite_digest), ['struct-d1', 'behav-d1']);
});

test('the public run flow reports a missing behavioral sidecar without invoking a fallback runner', async () => {
  let uploaded: Array<Record<string, unknown>> = [];

  await run(config(tmpProject()), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [behavioralSuite()], feature_suites: [] }),
    materializeBehavioral: (root, index) =>
      materializeBehavioralUnion(root, index, 'cucumber')!,
    runBehavioral: runBddSuite,
    postRunsBatch: async (runs) => {
      uploaded = runs as Array<Record<string, unknown>>;
      return { results: [], map_url: '' };
    },
  }));

  assert.match(
    String((uploaded[0].suite_error as Record<string, unknown>).output_tail),
    /Behavioral runner missing.*suite-prepare/,
  );
});

// Spec 52-3, AC 3.1 and 3.2. The checks of every red feature come down with
// the suites, are materialised beside the main suite as one union, and the
// main suite runs with their tags excluded. Since spec 52-4 (AC 1.1) the
// checks themselves run too, each by its own tag after the main suite, into
// the same batch; without any, nothing changes.
function featureSuite(id: number) {
  return {
    feature_id: id,
    title: `Feature ${id}`,
    feature_tag: `unitbob_feature_${id}`,
    suite_digest: `feat-${id}`,
    suite_file: {
      path: `.unitbob/behavioral/features/feature_${id}.feature`,
      content: `Feature: ${id}\n`,
      support_files: [{ path: `.unitbob/behavioral/step_definitions/feature_${id}_steps.rb`, content: '# f\n' }],
    },
    runner_manifest: { runner: 'cucumber', result_format: 'cucumber_messages' },
  };
}

test('materializes the union once, runs the main suite with every feature tag excluded, then each feature by its tag', async () => {
  const projectRoot = tmpProject();
  let uploaded: unknown[] = [];
  const filters: unknown[] = [];
  let materialized = 0;
  let output = '';

  await run(config(projectRoot), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [behavioralSuite()], feature_suites: [featureSuite(12), featureSuite(15)] }),
    materializeBehavioral: (_root, index) => { materialized += index.feature_suites.length; return { mainPath: 'main.feature', excludeTags: ['unitbob_feature_12', 'unitbob_feature_15'] }; },
    runBehavioral: async (_root, _runner, mainPath, f) => {
      filters.push([mainPath, f]);
      return runnerResult({ report: `{"run":${filters.length}}\n` });
    },
    postRunsBatch: async (runs) => {
      uploaded = runs;
      return {
        results: [
          { suite_kind: 'behavioral', suite_digest: 'behav-d1', status: 'ok', summary: 'Product behaviour checks passed.' },
          { suite_kind: 'behavioral', feature_id: 12, suite_digest: 'feat-12', status: 'failed', summary: 'Feature 12: 1 of 2 checks pass.', lamps: null },
          { suite_kind: 'behavioral', feature_id: 15, suite_digest: 'feat-15', status: 'ok', summary: 'Feature 15: all 2 checks pass — review them to unlock Finish.', lamps: null },
        ],
        map_url: 'https://host/repos/3/map',
      };
    },
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  }));

  assert.equal(materialized, 2, 'one union, written once');
  assert.deepEqual(filters, [
    ['main.feature', { exclude: ['unitbob_feature_12', 'unitbob_feature_15'] }],
    ['main.feature', { only: 'unitbob_feature_12' }],
    ['main.feature', { only: 'unitbob_feature_15' }],
  ]);
  assert.deepEqual(uploaded, [
    { suite_digest: 'behav-d1', run_result: '{"run":1}\n' },
    { suite_digest: 'feat-12', run_result: '{"run":2}\n' },
    { suite_digest: 'feat-15', run_result: '{"run":3}\n' },
  ]);
  // The server's line per feature, as it is — the wording is the server's.
  assert.match(output, /Product behaviour checks passed\.\nFeature 12: 1 of 2 checks pass\.\nFeature 15: all 2 checks pass — review them to unlock Finish\.\n/);
});

test('a feature whose runner fails files its own suite_error and stops neither the main suite nor the other feature', async () => {
  let uploaded: Array<Record<string, unknown>> = [];

  await run(config(tmpProject()), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [behavioralSuite()], feature_suites: [featureSuite(12), featureSuite(15)] }),
    runBehavioral: async (_root, _runner, _main, f) => {
      if (f && 'only' in f && f.only === 'unitbob_feature_12') throw new Error('step file feature_12_steps.rb raised NameError at load');
      return runnerResult({ report: '{"testCaseStarted":{}}\n' });
    },
    postRunsBatch: async (runs) => { uploaded = runs as Array<Record<string, unknown>>; return { results: [], map_url: '' }; },
  }));

  assert.deepEqual(uploaded.map((entry) => entry.suite_digest), ['behav-d1', 'feat-12', 'feat-15']);
  assert.equal('run_result' in uploaded[0], true);
  assert.match(String((uploaded[1].suite_error as Record<string, unknown>).output_tail), /NameError at load/);
  assert.equal('run_result' in uploaded[2], true);
});

test('a feature run that produced no report is that feature’s structured suite_error', async () => {
  let uploaded: Array<Record<string, unknown>> = [];

  await run(config(tmpProject()), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [behavioralSuite()], feature_suites: [featureSuite(12)] }),
    runBehavioral: async (_root, _runner, _main, f) =>
      f && 'only' in f
        ? runnerResult({ stderr: 'undefined method', code: 2, command: 'bundle', args: ['exec', 'cucumber', '--tags', '@unitbob_feature_12'], report: '' })
        : runnerResult({ report: '{"testCaseStarted":{}}\n' }),
    postRunsBatch: async (runs) => { uploaded = runs as Array<Record<string, unknown>>; return { results: [], map_url: '' }; },
  }));

  const error = uploaded[1].suite_error as Record<string, unknown>;
  assert.equal(uploaded[1].suite_digest, 'feat-12');
  assert.equal(error.command, 'bundle exec cucumber --tags @unitbob_feature_12');
  assert.equal(error.exit_code, 2);
  assert.match(String(error.output_tail), /undefined method/);
});

test('a behavioral stack mismatch is filed for the main suite and for every feature, and nothing is materialized', async () => {
  let uploaded: Array<Record<string, unknown>> = [];
  let materialized = false;

  await run(config(tmpProject()), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [behavioralSuite()], feature_suites: [featureSuite(12)] }),
    validateStack: () => ({ ok: false, message: 'this project does not look like Rails' }),
    materializeBehavioral: () => { materialized = true; return { mainPath: 'main.feature', excludeTags: [] }; },
    postRunsBatch: async (runs) => { uploaded = runs as Array<Record<string, unknown>>; return { results: [], map_url: '' }; },
  }));

  assert.equal(materialized, false);
  assert.deepEqual(uploaded.map((entry) => entry.suite_digest), ['behav-d1', 'feat-12']);
  assert.match(String((uploaded[1].suite_error as Record<string, unknown>).output_tail), /does not look like Rails/);
});

// A feature can have checks before the main suite is built (spec 52-3: the
// union of checks alone is legal). They still run, on the union of themselves.
test('feature checks run even when the main behavioral suite is not built', async () => {
  let uploaded: Array<Record<string, unknown>> = [];
  let runner: unknown = null;

  await run(config(tmpProject()), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [{ suite_kind: 'structural', status: 'not_built' }, { suite_kind: 'behavioral', status: 'not_built' }], feature_suites: [featureSuite(12)] }),
    materializeBehavioral: (_root, _index, r) => { runner = r; return { mainPath: 'feature_12.feature', excludeTags: ['unitbob_feature_12'] }; },
    runBehavioral: async () => runnerResult({ report: '{"testCaseStarted":{}}\n' }),
    postRunsBatch: async (runs) => { uploaded = runs as Array<Record<string, unknown>>; return { results: [], map_url: '' }; },
  }));

  assert.equal(runner, 'cucumber');
  assert.deepEqual(uploaded.map((entry) => entry.suite_digest), ['feat-12']);
});

// The first run after publishing (spec 32-4) runs the features too, but only
// when the behavioral branch was published: structural alone has no union.
test('the filtered run runs the features after a published behavioral branch, and not after structural alone', async () => {
  let uploaded: Array<Record<string, unknown>> = [];
  const deps = batchDeps({
    getSuiteIndex: async () => ({ suites: [structuralSuite(), behavioralSuite()], feature_suites: [featureSuite(12)] }),
    postRunsBatch: async (runs) => { uploaded = runs as Array<Record<string, unknown>>; return { results: [], map_url: '' }; },
  });

  await runOnly(config(tmpProject()), ['behav-d1'], deps);
  assert.deepEqual(uploaded.map((entry) => entry.suite_digest), ['behav-d1', 'feat-12']);

  await runOnly(config(tmpProject()), ['struct-d1'], deps);
  assert.deepEqual(uploaded.map((entry) => entry.suite_digest), ['struct-d1']);
});

test('without feature suites the behavioral run carries an empty exclusion', async () => {
  let filter: unknown = 'unset';

  await run(config(tmpProject()), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [behavioralSuite()], feature_suites: [] }),
    runBehavioral: async (_root, _runner, _main, f) => { filter = f; return runnerResult({ report: '{"testCaseStarted":{}}\n' }); },
  }));

  assert.deepEqual(filter, { exclude: [] });
});

test('the real union writes the feature files beside the main suite and wipes what neither lists', async () => {
  const projectRoot = tmpProject();
  const stale = join(projectRoot, '.unitbob', 'behavioral', 'features', 'stale.feature');
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral', 'features'), { recursive: true });
  writeFileSync(stale, 'Feature: stale\n');

  await run(config(projectRoot), [], batchDeps({
    getSuiteIndex: async () => ({ suites: [behavioralSuite()], feature_suites: [featureSuite(12)] }),
    materializeBehavioral: (root, index) => materializeBehavioralUnion(root, index, 'cucumber')!,
  }));

  assert.ok(existsSync(join(projectRoot, '.unitbob', 'behavioral', 'features', 'feature_12.feature')));
  assert.ok(existsSync(join(projectRoot, '.unitbob', 'behavioral', 'features', 'surface_contracts.feature')));
  assert.ok(!existsSync(stale));
});

// Spec 52-4, AC 1.8. A feature file rewired on disk and not saved stops the
// whole run before the disk is touched: this is not one branch's suite error
// to file and move past, it is the connector refusing to wipe work. The
// sentence reaches the terminal through the shared catch in `cli.ts`.
test('a feature file changed on disk stops the run before anything is cleared or posted', async () => {
  const projectRoot = tmpProject();
  materializeBehavioralUnion(projectRoot, { suites: [behavioralSuite()], feature_suites: [featureSuite(12)] }, 'cucumber');
  const rewired = join(projectRoot, '.unitbob', 'behavioral', 'step_definitions', 'feature_12_steps.rb');
  writeFileSync(rewired, '# rewired against the real code\n');
  let posted = false;

  await assert.rejects(
    () => run(config(projectRoot), [], batchDeps({
      getSuiteIndex: async () => ({ suites: [structuralSuite(), behavioralSuite()], feature_suites: [featureSuite(12)] }),
      materializeBehavioral: (root, index) => materializeBehavioralUnion(root, index, 'cucumber')!,
      postRunsBatch: async () => { posted = true; return { results: [], map_url: '' }; },
    })),
    (err: unknown) => err instanceof FeatureFilesChangedError && /The checks for “Feature 12” changed on disk/.test(err.message),
  );

  assert.equal(posted, false);
  assert.equal(readFileSync(rewired, 'utf8'), '# rewired against the real code\n');
});
