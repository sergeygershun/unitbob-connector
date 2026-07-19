import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/verbs/run.ts';
import type { Config } from '../src/config.ts';
import type { SuiteBlob } from '../src/files/guardrails.ts';
import type { RunnerResult } from '../src/runner/types.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-check-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

const okStack = () => ({ ok: true });

function suite(runner = 'rspec'): SuiteBlob {
  const byRunner: Record<string, { path: string; language: string; framework: string; result_format: string }> = {
    rspec: { path: '.unitbob/guardrails/architecture_map_contracts_spec.rb', language: 'ruby', framework: 'rspec', result_format: 'rspec_json' },
    vitest: { path: '.unitbob/guardrails/architecture_map_contracts.test.ts', language: 'javascript', framework: 'vitest', result_format: 'vitest_json' },
    pytest: { path: '.unitbob/guardrails/test_architecture_map_contracts.py', language: 'python', framework: 'pytest', result_format: 'junit_xml' },
  };
  const stack = byRunner[runner];
  return {
    suite_digest: 'd1',
    suite_file: { path: stack.path, content: 'suite bytes' },
    runner_manifest: { language: stack.language, framework: stack.framework, result_format: stack.result_format, runner },
  };
}

function runnerResult(overrides: Partial<RunnerResult>): RunnerResult {
  return {
    stdout: '',
    stderr: '',
    code: 0,
    command: 'runner',
    args: [],
    resultPath: '.unitbob/guardrails/rspec_result.json',
    report: '',
    ...overrides,
  };
}

test('a stack mismatch stops the check before any file is written', async () => {
  let materialized = false;
  let ran = false;
  await assert.rejects(
    () =>
      run(config(tmpProject()), [], {
        getSuite: async () => suite('vitest'),
        validateStack: () => ({ ok: false, message: 'JS/TS guardrails require Vitest, which was not found.' }),
        materializeGuardrails: () => {
          materialized = true;
          return { suitePath: 'x' };
        },
        runSuite: async () => {
          ran = true;
          return runnerResult({});
        },
        stdout: { write: () => true },
      }),
    /require Vitest/,
  );
  assert.equal(materialized, false);
  assert.equal(ran, false);
});

test('204 suite response prints a no-suite message and does not run anything', async () => {
  let ran = false;
  let output = '';

  await run(config(tmpProject()), [], {
    getSuite: async () => null,
    validateStack: okStack,
    runSuite: async () => {
      ran = true;
      return runnerResult({});
    },
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  });

  assert.equal(ran, false);
  assert.match(output, /No Unitbob suite exists yet/);
});

test('successful run uploads the report as run_result even when the app pollutes stdout', async () => {
  const projectRoot = tmpProject();
  const calls: string[] = [];
  let uploaded: unknown = null;
  let output = '';

  await run(config(projectRoot), [], {
    getSuite: async () => suite(),
    validateStack: okStack,
    materializeGuardrails: (root) => {
      calls.push(`materialize:${root}`);
      return { suitePath: join(root, '.unitbob', 'guardrails', 'architecture_map_contracts_spec.rb') };
    },
    runSuite: async (root, runner, suitePath) => {
      calls.push(`run:${root}:${runner}:${suitePath}`);
      // The report is clean in `report`; stdout carries app noise that would
      // break a stdout-parsed run. The result file keeps the report intact.
      return runnerResult({
        stdout: '{"examples":[]}\nDEPRECATION WARNING: something\n',
        report: '{"examples":[]}',
      });
    },
    postRun: async (payload) => {
      uploaded = payload;
      return { summary: 'Architecture checks passed.', map_url: 'https://host/repos/3/map', lamps: {} };
    },
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  });

  assert.deepEqual(calls, [
    `materialize:${projectRoot}`,
    `run:${projectRoot}:rspec:.unitbob/guardrails/architecture_map_contracts_spec.rb`,
  ]);
  assert.deepEqual(uploaded, { suite_digest: 'd1', run_result: '{"examples":[]}' });
  assert.match(output, /Architecture checks passed/);
  assert.match(output, /https:\/\/host\/repos\/3\/map/);
});

test('a pytest run ships the JUnit XML report unchanged when nothing exceeds the bound', async () => {
  let uploaded: Record<string, unknown> = {};
  const xml = '<?xml version="1.0"?><testsuites><testsuite tests="1"/></testsuites>';

  await run(config(tmpProject()), [], {
    getSuite: async () => suite('pytest'),
    validateStack: okStack,
    materializeGuardrails: () => ({ suitePath: 'x' }),
    runSuite: async () => runnerResult({ report: xml, resultPath: '.unitbob/guardrails/pytest_result.xml' }),
    postRun: async (payload) => {
      uploaded = payload as Record<string, unknown>;
      return { summary: 'ok', map_url: '', lamps: {} };
    },
    stdout: { write: () => true },
  });

  assert.equal(uploaded.run_result, xml);
});

test('long pytest failure text is size-bounded before upload, keeping the XML well-formed', async () => {
  let uploaded: Record<string, unknown> = {};
  const longBody = 'x'.repeat(9000);
  const longAttr = 'y'.repeat(9000);
  const xml =
    `<?xml version="1.0"?><testsuites><testsuite tests="1">` +
    `<testcase name="test_ubc_a13f09c7b2d4_charges"><failure message="${longAttr}">${longBody}</failure></testcase>` +
    `</testsuite></testsuites>`;

  await run(config(tmpProject()), [], {
    getSuite: async () => suite('pytest'),
    validateStack: okStack,
    materializeGuardrails: () => ({ suitePath: 'x' }),
    runSuite: async () => runnerResult({ code: 1, report: xml, resultPath: '.unitbob/guardrails/pytest_result.xml' }),
    postRun: async (payload) => {
      uploaded = payload as Record<string, unknown>;
      return { summary: 'attention', map_url: '', lamps: {} };
    },
    stdout: { write: () => true },
  });

  const report = String(uploaded.run_result);
  assert.ok(report.length < xml.length, 'report bounded');
  assert.match(report, /truncated/);
  assert.ok(!report.includes(longBody), 'failure body truncated');
  assert.ok(!report.includes(longAttr), 'message attribute truncated');
  // Still parses and still carries the case marker Rails joins on.
  assert.match(report, /ubc_a13f09c7b2d4/);
  assert.match(report, /<\/testsuites>/);
});

test('long rspec failure text is size-bounded before upload', async () => {
  let uploaded: Record<string, unknown> = {};
  const longMessage = 'x'.repeat(9000);

  await run(config(tmpProject()), [], {
    getSuite: async () => suite(),
    validateStack: okStack,
    materializeGuardrails: () => ({ suitePath: 'x' }),
    runSuite: async () =>
      runnerResult({
        code: 1,
        report: JSON.stringify({
          examples: [{ id: './x[1:1]', status: 'failed', exception: { message: longMessage, backtrace: Array(50).fill('frame') } }],
        }),
      }),
    postRun: async (payload) => {
      uploaded = payload as Record<string, unknown>;
      return { summary: 'attention', map_url: '', lamps: {} };
    },
    stdout: { write: () => true },
  });

  const parsed = JSON.parse(String(uploaded.run_result)) as {
    examples: Array<{ exception: { message: string; backtrace: string[] } }>;
  };
  assert.ok(parsed.examples[0].exception.message.length < longMessage.length, 'message truncated');
  assert.match(parsed.examples[0].exception.message, /truncated/);
  assert.ok(parsed.examples[0].exception.backtrace.length <= 20, 'backtrace capped');
});

test('long vitest failure messages are size-bounded before upload', async () => {
  let uploaded: Record<string, unknown> = {};
  const longMessage = 'y'.repeat(9000);

  await run(config(tmpProject()), [], {
    getSuite: async () => suite('vitest'),
    validateStack: okStack,
    materializeGuardrails: () => ({ suitePath: 'x' }),
    runSuite: async () =>
      runnerResult({
        code: 1,
        report: JSON.stringify({
          testResults: [{ assertionResults: [{ title: '[ubc_a13f09c7b2d4] fails', status: 'failed', failureMessages: [longMessage] }] }],
        }),
        resultPath: '.unitbob/guardrails/vitest_result.json',
      }),
    postRun: async (payload) => {
      uploaded = payload as Record<string, unknown>;
      return { summary: 'attention', map_url: '', lamps: {} };
    },
    stdout: { write: () => true },
  });

  const parsed = JSON.parse(String(uploaded.run_result)) as {
    testResults: Array<{ assertionResults: Array<{ failureMessages: string[] }> }>;
  };
  const message = parsed.testResults[0].assertionResults[0].failureMessages[0];
  assert.ok(message.length < longMessage.length, 'message truncated');
  assert.match(message, /truncated/);
});

test('a run that produces no report uploads a structured suite_error, never per-contract results', async () => {
  let uploaded: Record<string, unknown> = {};

  await run(config(tmpProject()), [], {
    getSuite: async () => suite('vitest'),
    validateStack: okStack,
    materializeGuardrails: () => ({ suitePath: 'x' }),
    // No report file was written (vitest is not installed); stderr carries the
    // load error. This is the genuine structured suite-error path.
    runSuite: async () =>
      runnerResult({
        stdout: '',
        stderr: "Error: Cannot find module 'vitest'",
        code: 1,
        command: 'npx',
        args: ['vitest', 'run', '.unitbob/guardrails/architecture_map_contracts.test.ts'],
        resultPath: '.unitbob/guardrails/vitest_result.json',
        report: '',
      }),
    postRun: async (payload) => {
      uploaded = payload as Record<string, unknown>;
      return { summary: 'Unitbob could not run checks.', map_url: 'https://host/repos/3/map', lamps: {} };
    },
    stdout: { write: () => true },
  });

  assert.equal(uploaded.suite_digest, 'd1');
  const error = uploaded.suite_error as Record<string, unknown>;
  assert.equal(error.command, 'npx vitest run .unitbob/guardrails/architecture_map_contracts.test.ts');
  assert.equal(error.exit_code, 1);
  assert.equal(error.result_path, '.unitbob/guardrails/vitest_result.json');
  assert.match(String(error.output_tail), /Cannot find module 'vitest'/);
  assert.equal('run_result' in uploaded, false);
});
