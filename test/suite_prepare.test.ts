import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suitePrepare } from '../src/verbs/suitePrepare.ts';
import { UNITBOB_HELPER_RB } from '../src/files/guardrails.ts';
import { readSuiteBuildRequest } from '../src/files/suiteBuild.ts';
import type { Config } from '../src/config.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-suite-prepare-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

const okPrecheck = () => ({ ok: true });

test('suite-prepare fetches the generate recipe and the capability assignment, then writes request.json', async () => {
  const projectRoot = tmpProject();
  const calls: string[] = [];

  await suitePrepare(config(projectRoot), [], {
    precheck: okPrecheck,
    getRecipe: async (name) => {
      calls.push(`recipe:${name}`);
      return { name, version: `${name}-v1`, text: `${name} recipe` };
    },
    getSuitePackets: async () => {
      calls.push('packets');
      return { map_digest: 'sha256-map', blocks: [{ block_id: 'billing', interfaces: [] }] };
    },
  });

  assert.deepEqual(calls.sort(), ['packets', 'recipe:generate']);
  const request = readSuiteBuildRequest(projectRoot);
  assert.equal(request.map_digest, 'sha256-map');
  assert.equal(request.recipe.text, 'generate recipe');
  assert.deepEqual(request.blocks, [{ block_id: 'billing', interfaces: [] }]);
});

test('suite-prepare prints a next-step naming the recipe, output_path, and put-suite-build', async () => {
  const projectRoot = tmpProject();
  let output = '';
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    await suitePrepare(config(projectRoot), [], {
      precheck: okPrecheck,
      getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
      getSuitePackets: async () => ({ map_digest: 'sha256-map', blocks: [] }),
    });
  } finally {
    process.stdout.write = original;
  }

  const outputPath = join(projectRoot, '.unitbob', 'suite-build', 'suite_output.json');
  assert.match(output, /Next: write the complete guardrail spec/);
  assert.ok(output.includes(outputPath), 'names the output_path');
  assert.match(output, /`recipe`/);
  assert.match(output, /capability `blocks`/);
  assert.match(output, /`unitbob put-suite-build`/);
});

test('suite-prepare materializes the boot helper right after the precheck', async () => {
  const projectRoot = tmpProject();

  await suitePrepare(config(projectRoot), [], {
    precheck: okPrecheck,
    getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
    getSuitePackets: async () => ({ map_digest: 'sha256-map', blocks: [] }),
  });

  const helperPath = join(projectRoot, '.unitbob', 'guardrails', 'unitbob_helper.rb');
  assert.equal(readFileSync(helperPath, 'utf8'), UNITBOB_HELPER_RB);
});

test('suite-prepare stops on an unsupported runtime and writes nothing', async () => {
  const projectRoot = tmpProject();
  let fetched = false;

  await assert.rejects(
    () =>
      suitePrepare(config(projectRoot), [], {
        precheck: () => ({ ok: false, message: 'This project does not look like Rails + RSpec.' }),
        getRecipe: async () => {
          fetched = true;
          return { name: 'generate', version: 'v1', text: 'recipe' };
        },
        getSuitePackets: async () => ({ map_digest: 'm', blocks: [] }),
      }),
    /Rails \+ RSpec/,
  );

  assert.equal(fetched, false);
  assert.throws(() => readSuiteBuildRequest(projectRoot), /run `npx unitbob suite-prepare` first/);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'guardrails', 'unitbob_helper.rb')), false);
});

test('suite-prepare surfaces a no-current-map error and writes nothing', async () => {
  const projectRoot = tmpProject();

  await assert.rejects(
    () =>
      suitePrepare(config(projectRoot), [], {
        precheck: okPrecheck,
        getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
        getSuitePackets: async () => {
          throw new Error('GET /repos/3/suite_packets failed: 409 — run `/unitbob map` first.');
        },
      }),
    /unitbob map/,
  );

  assert.throws(() => readSuiteBuildRequest(projectRoot), /run `npx unitbob suite-prepare` first/);
});
