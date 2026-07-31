import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { run, runOnly } from '../src/verbs/run.ts';
import { materializeBehavioral } from '../src/files/behavioral.ts';
import { runBddSuite } from '../src/runner/bdd.ts';
import type { Config } from '../src/config.ts';
import type { RunnerResult } from '../src/runner/types.ts';
import type { SuiteListItem } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-check-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
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
    materializeBehavioral: () => '.unitbob/behavioral/features/surface_contracts.feature',
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
    getSuites: async () => [
      { suite_kind: 'structural', status: 'not_built' },
      { suite_kind: 'behavioral', status: 'not_built' },
    ],
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
    getSuites: async () => [structuralSuite(), behavioralSuite()],
    materializeStructural: (_root, item) => { calls.push(`mat-struct:${item.suite_kind}`); },
    materializeBehavioral: (_root, item) => { calls.push(`mat-behav:${item.suite_kind}`); return 'main.feature'; },
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
  assert.match(output, /https:\/\/host\/repos\/3\/map/);
});

test('a structural stack mismatch becomes that branch suite_error; the behavioral branch still runs', async () => {
  let uploaded: Array<Record<string, unknown>> = [];
  let structuralMaterialized = false;

  await run(config(tmpProject()), [], batchDeps({
    getSuites: async () => [structuralSuite('vitest'), behavioralSuite()],
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
    getSuites: async () => [structuralSuite(), behavioralSuite()],
    // Only the behavioral (cucumber) branch fails its language check.
    validateStack: (_root, runner) =>
      runner === 'cucumber'
        ? { ok: false, message: 'The behavioral (Gherkin) suite selected the Ruby stack, but this project does not look like Rails.' }
        : { ok: true },
    materializeBehavioral: () => { behavioralMaterialized = true; return 'main.feature'; },
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
    getSuites: async () => [structuralSuite('vitest')],
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
    getSuites: async () => [behavioralSuite()],
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
    getSuites: async () => [behavioralSuite()],
    materializeBehavioral: (root, item) =>
      materializeBehavioral(root, item.suite_file!, item.runner_manifest!.runner).mainPath,
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
      getSuites: async () => [behavioralSuite()],
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
    getSuites: async () => [structuralSuite(), behavioralSuite()],
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
        getSuites: async () => [structuralSuite()],
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
        getSuites: async () => [{ ...structuralSuite(), status: 'not_built' }],
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
    getSuites: async () => [structuralSuite(), behavioralSuite()],
    postRunsBatch: async (runs) => { uploaded = runs as Array<Record<string, unknown>>; return { results: [], map_url: '' }; },
  }));

  assert.deepEqual(uploaded.map((entry) => entry.suite_digest), ['struct-d1', 'behav-d1']);
});

test('the public run flow reports a missing behavioral sidecar without invoking a fallback runner', async () => {
  let uploaded: Array<Record<string, unknown>> = [];

  await run(config(tmpProject()), [], batchDeps({
    getSuites: async () => [behavioralSuite()],
    materializeBehavioral: (root, item) =>
      materializeBehavioral(root, item.suite_file!, item.runner_manifest!.runner).mainPath,
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
