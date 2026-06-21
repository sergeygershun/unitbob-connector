import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suitePrepare } from '../src/verbs/suitePrepare.ts';
import { readSuiteBuildRequest } from '../src/files/suiteBuild.ts';
import type { Config } from '../src/config.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-suite-prepare-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

test('suite-prepare fetches the generate recipe and packets, then writes request.json', async () => {
  const projectRoot = tmpProject();
  const calls: string[] = [];

  await suitePrepare(config(projectRoot), [], {
    getRecipe: async (name) => {
      calls.push(`recipe:${name}`);
      return { name, version: `${name}-v1`, text: `${name} recipe` };
    },
    getSuitePackets: async () => {
      calls.push('packets');
      return { map_digest: 'sha256-map', packets: [{ block: { id: 'block:billing' } }] };
    },
  });

  assert.deepEqual(calls.sort(), ['packets', 'recipe:generate']);
  const request = readSuiteBuildRequest(projectRoot);
  assert.equal(request.map_digest, 'sha256-map');
  assert.equal(request.recipe.text, 'generate recipe');
  assert.deepEqual(request.packets, [{ block: { id: 'block:billing' } }]);
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
      getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
      getSuitePackets: async () => ({ map_digest: 'sha256-map', packets: [] }),
    });
  } finally {
    process.stdout.write = original;
  }

  const outputPath = join(projectRoot, '.unitbob', 'suite-build', 'suite_output.json');
  assert.match(output, /Next: build the guardrail suite at/);
  assert.ok(output.includes(outputPath), 'names the output_path');
  assert.match(output, /`recipe`/);
  assert.match(output, /per-block `packets`/);
  assert.match(output, /`unitbob put-suite-build`/);
});

test('suite-prepare surfaces a no-current-map error and writes nothing', async () => {
  const projectRoot = tmpProject();

  await assert.rejects(
    () =>
      suitePrepare(config(projectRoot), [], {
        getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
        getSuitePackets: async () => {
          throw new Error('GET /repos/3/suite_packets failed: 409 — run `/unitbob map` first.');
        },
      }),
    /unitbob map/,
  );

  assert.throws(() => readSuiteBuildRequest(projectRoot), /run `npx unitbob suite-prepare` first/);
});
