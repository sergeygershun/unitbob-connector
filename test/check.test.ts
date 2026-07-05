import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/verbs/run.ts';
import type { Config } from '../src/config.ts';
import type { SuiteBlob } from '../src/files/guardrails.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-check-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

const okPrecheck = () => ({ ok: true });

function suite(): SuiteBlob {
  return { suite_digest: 'd1', spec_rb: "require 'rails_helper'\n\nRSpec.describe('x') {}\n" };
}

test('an unsupported runtime stops the check before fetching the suite', async () => {
  let fetched = false;
  await assert.rejects(
    () =>
      run(config(tmpProject()), [], {
        precheck: () => ({ ok: false, message: 'This project does not look like Rails + RSpec.' }),
        getSuite: async () => {
          fetched = true;
          return null;
        },
        stdout: { write: () => true },
      }),
    /Rails \+ RSpec/,
  );
  assert.equal(fetched, false);
});

test('204 suite response prints a no-suite message and does not run RSpec', async () => {
  let ran = false;
  let output = '';

  await run(config(tmpProject()), [], {
    precheck: okPrecheck,
    getSuite: async () => null,
    runRspecSuite: async () => {
      ran = true;
      return { stdout: '', stderr: '', code: 0, command: 'rspec', args: [], jsonReport: '{}' };
    },
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  });

  assert.equal(ran, false);
  assert.match(output, /No Unitbob suite exists yet/);
});

test('successful run uploads the JSON report even when the app pollutes stdout', async () => {
  const projectRoot = tmpProject();
  const calls: string[] = [];
  let uploaded: unknown = null;
  let output = '';

  await run(config(projectRoot), [], {
    precheck: okPrecheck,
    getSuite: async () => suite(),
    materializeGuardrails: (root) => {
      calls.push(`materialize:${root}`);
      return { suitePath: join(root, '.unitbob', 'guardrails', 'architecture_map_contracts_spec.rb') };
    },
    runRspecSuite: async (root) => {
      calls.push(`run:${root}`);
      // The report is clean in jsonReport; stdout carries app noise that would
      // break a stdout-parsed run. The `--out` file keeps the report intact.
      return {
        stdout: '{"examples":[]}\nDEPRECATION WARNING: something\n',
        stderr: '',
        code: 0,
        command: 'rspec',
        args: [],
        jsonReport: '{"examples":[]}',
      };
    },
    postRun: async (payload) => {
      uploaded = payload;
      return { summary: 'Architecture checks passed.', map_url: 'https://host/repos/3/map', lamps: {} };
    },
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  });

  assert.deepEqual(calls, [`materialize:${projectRoot}`, `run:${projectRoot}`]);
  assert.deepEqual(uploaded, { suite_digest: 'd1', rspec_json: { examples: [] } });
  assert.match(output, /Architecture checks passed/);
  assert.match(output, /https:\/\/host\/repos\/3\/map/);
});

test('long failure text is size-bounded before upload', async () => {
  let uploaded: Record<string, unknown> = {};
  const longMessage = 'x'.repeat(9000);

  await run(config(tmpProject()), [], {
    precheck: okPrecheck,
    getSuite: async () => suite(),
    materializeGuardrails: () => ({ suitePath: 'x' }),
    runRspecSuite: async () => ({
      stdout: '',
      stderr: '',
      code: 1,
      command: 'rspec',
      args: [],
      jsonReport: JSON.stringify({
        examples: [{ id: './x[1:1]', status: 'failed', exception: { message: longMessage, backtrace: Array(50).fill('frame') } }],
      }),
    }),
    postRun: async (payload) => {
      uploaded = payload as Record<string, unknown>;
      return { summary: 'attention', map_url: '', lamps: {} };
    },
    stdout: { write: () => true },
  });

  const example = (uploaded.rspec_json as { examples: Array<{ exception: { message: string; backtrace: string[] } }> }).examples[0];
  assert.ok(example.exception.message.length < longMessage.length, 'message truncated');
  assert.match(example.exception.message, /truncated/);
  assert.ok(example.exception.backtrace.length <= 20, 'backtrace capped');
});

test('a boot failure with no JSON report uploads suite_error', async () => {
  let uploaded = {};

  await run(config(tmpProject()), [], {
    precheck: okPrecheck,
    getSuite: async () => suite(),
    materializeGuardrails: () => ({ suitePath: 'x' }),
    // No report file was written (the suite failed to boot); stdout/stderr carry
    // the load error. This is the genuine suite-error path.
    runRspecSuite: async () => ({
      stdout: 'cannot load spec',
      stderr: 'LoadError',
      code: 1,
      command: 'rspec',
      args: [],
      jsonReport: '',
    }),
    postRun: async (payload) => {
      uploaded = payload as Record<string, unknown>;
      return { summary: 'Unitbob could not run checks.', map_url: 'https://host/repos/3/map', lamps: {} };
    },
    stdout: { write: () => true },
  });

  assert.equal((uploaded as Record<string, unknown>).suite_digest, 'd1');
  assert.match(String((uploaded as Record<string, unknown>).suite_error), /LoadError/);
  assert.match(String((uploaded as Record<string, unknown>).suite_error), /cannot load spec/);
});
