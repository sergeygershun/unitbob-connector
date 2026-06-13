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

function suite(): SuiteBlob {
  return { suite_digest: 'd1', spec_rb: "RSpec.describe('x') {}\n", manifest: { guardrails_id: 'g1' } };
}

test('204 suite response prints a no-suite message and does not run RSpec', async () => {
  let ran = false;
  let output = '';

  await run(config(tmpProject()), [], {
    getSuite: async () => null,
    runRspecSuite: async () => {
      ran = true;
      return { stdout: '{}', stderr: '', code: 0, command: 'rspec', args: [] };
    },
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  });

  assert.equal(ran, false);
  assert.match(output, /No Unitbob suite exists yet/);
});

test('successful run uploads raw RSpec JSON and prints Rails summary and map URL', async () => {
  const projectRoot = tmpProject();
  const calls: string[] = [];
  let uploaded: unknown = null;
  let output = '';

  await run(config(projectRoot), [], {
    getSuite: async () => suite(),
    materializeGuardrails: (root) => {
      calls.push(`materialize:${root}`);
      return { suitePath: join(root, '.unitbob', 'guardrails', 'architecture_map_contracts_spec.rb') };
    },
    runRspecSuite: async (root) => {
      calls.push(`run:${root}`);
      return { stdout: '{"examples":[]}', stderr: '', code: 0, command: 'rspec', args: [] };
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

test('non-JSON runner output uploads suite_error', async () => {
  let uploaded = {};

  await run(config(tmpProject()), [], {
    getSuite: async () => suite(),
    materializeGuardrails: () => ({ suitePath: 'x' }),
    runRspecSuite: async () => ({
      stdout: 'cannot load spec',
      stderr: 'LoadError',
      code: 1,
      command: 'rspec',
      args: [],
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
