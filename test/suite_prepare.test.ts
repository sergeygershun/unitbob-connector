import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suitePrepare } from '../src/verbs/suitePrepare.ts';
import { UNITBOB_HELPER_RB } from '../src/files/guardrails.ts';
import { readSuiteBuildRequest } from '../src/files/suiteBuild.ts';
import type { Config } from '../src/config.ts';
import type { SuitePacket } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-suite-prepare-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

const okPrecheck = () => ({ ok: true });
const okRunner = async () => ({ status: 'provisioned' as const });

function packets(): SuitePacket[] {
  return [
    {
      suite_kind: 'structural',
      source_digest: 'map-d',
      path_root: '.unitbob/structural/',
      assignment: { blocks: [{ block_id: 'billing', interfaces: [] }] },
    },
    {
      suite_kind: 'behavioral',
      source_digest: 'surface-d',
      path_root: '.unitbob/behavioral/',
      assignment: { capabilities: [{ capability_id: 'checkout' }] },
    },
  ];
}

test('suite-prepare fetches both peer assignments and each branch recipe, then writes request.json', async () => {
  const projectRoot = tmpProject();
  const calls: string[] = [];

  await suitePrepare(config(projectRoot), [], {
    precheck: okPrecheck,
    ensureRunner: okRunner,
    getRecipe: async (name) => { calls.push(`recipe:${name}`); return { name, version: `${name}-v1`, text: `${name} recipe` }; },
    getSuitePacketsBatch: async () => { calls.push('packets'); return packets(); },
    stdout: { write: () => true },
  });

  assert.deepEqual(calls.sort(), ['packets', 'recipe:generate', 'recipe:generate_behavioral']);
  const request = readSuiteBuildRequest(projectRoot);
  assert.deepEqual(request.branches.map((branch) => branch.suite_kind), ['structural', 'behavioral']);

  const structural = request.branches.find((branch) => branch.suite_kind === 'structural')!;
  assert.equal(structural.source_digest, 'map-d');
  assert.equal(structural.path_root, '.unitbob/structural/');
  assert.equal(structural.recipe.name, 'generate');

  const behavioral = request.branches.find((branch) => branch.suite_kind === 'behavioral')!;
  assert.equal(behavioral.source_digest, 'surface-d');
  assert.equal(behavioral.recipe.name, 'generate_behavioral');
});

test('suite-prepare prints a next-step naming both kinds, the output_path, and put-suite-build', async () => {
  const projectRoot = tmpProject();
  let output = '';

  await suitePrepare(config(projectRoot), [], {
    precheck: okPrecheck,
    ensureRunner: okRunner,
    getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  });

  const outputPath = join(projectRoot, '.unitbob', 'suite-build', 'suite_output.json');
  assert.match(output, /build both peer suites/);
  assert.match(output, /structural and behavioral/);
  assert.ok(output.includes(outputPath), 'names the output_path');
  assert.match(output, /`unitbob put-suite-build`/);
});

test('suite-prepare materializes the boot helper right after the precheck', async () => {
  const projectRoot = tmpProject();

  await suitePrepare(config(projectRoot), [], {
    precheck: okPrecheck,
    ensureRunner: okRunner,
    getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: () => true },
  });

  const helperPath = join(projectRoot, '.unitbob', 'structural', 'unitbob_helper.rb');
  assert.equal(readFileSync(helperPath, 'utf8'), UNITBOB_HELPER_RB);
});

test('suite-prepare stops on an unsupported runtime and writes nothing', async () => {
  const projectRoot = tmpProject();
  let fetched = false;

  await assert.rejects(
    () =>
      suitePrepare(config(projectRoot), [], {
        precheck: () => ({ ok: false, message: 'This project does not look like Rails + RSpec.' }),
        getRecipe: async () => { fetched = true; return { name: 'generate', version: 'v1', text: 'recipe' }; },
        getSuitePacketsBatch: async () => packets(),
        stdout: { write: () => true },
      }),
    /Rails \+ RSpec/,
  );

  assert.equal(fetched, false);
  assert.throws(() => readSuiteBuildRequest(projectRoot), /run `npx unitbob suite-prepare` first/);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'structural', 'unitbob_helper.rb')), false);
});

test('suite-prepare surfaces a no-current-map error and writes nothing', async () => {
  const projectRoot = tmpProject();

  await assert.rejects(
    () =>
      suitePrepare(config(projectRoot), [], {
        precheck: okPrecheck,
        getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
        getSuitePacketsBatch: async () => {
          throw new Error('GET /repos/3/suite_packets failed: 409 — rebuild the Unitbob map first.');
        },
        stdout: { write: () => true },
      }),
    /rebuild the Unitbob map/,
  );

  assert.throws(() => readSuiteBuildRequest(projectRoot), /run `npx unitbob suite-prepare` first/);
});

test('a fixable behavioral runner blocker does not abort the build or block the structural peer', async () => {
  const projectRoot = tmpProject();
  let output = '';

  // Spec 32-1: a `fixable` provision outcome is infrastructure the vibecoder clears with one
  // command — never a build_error dead-end, never a red lamp, and it must not take the structural
  // suite down with it.
  await suitePrepare(config(projectRoot), [], {
    precheck: okPrecheck,
    ensureRunner: async () => ({
      status: 'fixable',
      message: 'Bundler missing',
      checklist: ['Install bundler (`gem install bundler`)'],
    }),
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  });

  // Structural still builds; the unprovisioned behavioral branch is dropped from this run.
  const request = readSuiteBuildRequest(projectRoot);
  assert.deepEqual(request.branches.map((branch) => branch.suite_kind), ['structural']);

  // The vibecoder gets a fixable checklist, not a failure.
  assert.match(output, /Behavioral suite skipped this run/);
  assert.match(output, /Bundler missing/);
  assert.match(output, /Install bundler/);
  assert.doesNotMatch(output, /build_error|provision incomplete/i);
});

test('suite-prepare invokes the runner provision for the behavioral branch', async () => {
  const projectRoot = tmpProject();
  const provisioned: string[] = [];

  // Regression guard for the stub-default bug: provisioning must actually run for the behavioral
  // peer during preflight. (The production default is the real `ensureRunner`; `noUnusedLocals`
  // fails the build if that import is ever left unwired again.)
  await suitePrepare(config(projectRoot), [], {
    precheck: okPrecheck,
    ensureRunner: async (_root, runner) => { provisioned.push(runner); return { status: 'provisioned' }; },
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: () => true },
  });

  assert.deepEqual(provisioned, ['cucumber']);
});

test('a provisioned behavioral runner keeps both peer suites in the request', async () => {
  const projectRoot = tmpProject();

  await suitePrepare(config(projectRoot), [], {
    precheck: okPrecheck,
    ensureRunner: async () => ({ status: 'provisioned' }),
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: () => true },
  });

  const request = readSuiteBuildRequest(projectRoot);
  assert.deepEqual(request.branches.map((branch) => branch.suite_kind), ['structural', 'behavioral']);
});

