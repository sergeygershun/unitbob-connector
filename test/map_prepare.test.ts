import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapPrepare } from '../src/verbs/mapPrepare.ts';
import { readMapBuildRequest } from '../src/files/mapBuild.ts';
import type { Config } from '../src/config.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-map-prepare-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

test('map-prepare runs graphify, fetches recipes, and writes request.json', async () => {
  const projectRoot = tmpProject();
  const calls: string[] = [];

  await mapPrepare(config(projectRoot), [], {
    ensureUnitbobIgnored: (root) => calls.push(`ignore:${root}`),
    requireGraphify: async () => calls.push('requireGraphify'),
    runGraphifyExtract: async () => {
      calls.push('graphify');
      mkdirSync(join(projectRoot, '.unitbob', 'graphify-out'), { recursive: true });
      writeFileSync(join(projectRoot, '.unitbob', 'graphify-out', 'graph.json'), '{ "nodes": [] }\n');
      return { stdout: '', stderr: '', code: 0 };
    },
    getRecipe: async (name) => {
      calls.push(`recipe:${name}`);
      return { name, version: `${name}-v1`, text: `${name} recipe` };
    },
  });

  assert.deepEqual(calls, [
    `ignore:${projectRoot}`,
    'requireGraphify',
    'graphify',
    'recipe:decompose',
    'recipe:relate',
  ]);
  const packet = readMapBuildRequest(projectRoot);
  assert.equal(packet.recipes.decompose.text, 'decompose recipe');
  assert.equal(packet.recipes.relate.text, 'relate recipe');
});

test('map-prepare prints a next-step naming the recipes, output_path, and put-map-build', async () => {
  const projectRoot = tmpProject();
  let output = '';
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    await mapPrepare(config(projectRoot), [], {
      ensureUnitbobIgnored: () => {},
      requireGraphify: async () => {},
      runGraphifyExtract: async () => {
        mkdirSync(join(projectRoot, '.unitbob', 'graphify-out'), { recursive: true });
        writeFileSync(join(projectRoot, '.unitbob', 'graphify-out', 'graph.json'), '{ "nodes": [] }\n');
        return { stdout: '', stderr: '', code: 0 };
      },
      getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
    });
  } finally {
    process.stdout.write = original;
  }

  const outputPath = join(projectRoot, '.unitbob', 'map-build', 'map_document.json');
  assert.match(output, /Next: build the Map Document at/);
  assert.ok(output.includes(outputPath), 'names the output_path');
  assert.match(output, /recipes\.decompose and recipes\.relate/);
  assert.match(output, /`unitbob put-map-build`/);
});

test('map-prepare exits before recipes when graphify fails', async () => {
  const projectRoot = tmpProject();
  let fetchedRecipe = false;

  await assert.rejects(
    () =>
      mapPrepare(config(projectRoot), [], {
        ensureUnitbobIgnored: () => {},
        requireGraphify: async () => {},
        runGraphifyExtract: async () => ({ stdout: '', stderr: 'boom', code: 1 }),
        getRecipe: async (name) => {
          fetchedRecipe = true;
          return { name, version: 'v1', text: 'recipe' };
        },
      }),
    /graphify extract failed: boom/,
  );

  assert.equal(fetchedRecipe, false);
});
