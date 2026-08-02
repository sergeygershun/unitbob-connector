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

test('map-prepare keylessly updates the canonical graph, fetches recipes, and writes request.json', async () => {
  const projectRoot = tmpProject();
  const calls: string[] = [];

  await mapPrepare(config(projectRoot), [], {
    ensureUnitbobIgnored: (root) => calls.push(`ignore:${root}`),
    requireGraphify: async () => calls.push('requireGraphify'),
    runGraphifyExtractKeyless: async () => {
      calls.push('graphify');
      mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
      writeFileSync(join(projectRoot, 'graphify-out', 'graph.json'), '{ "nodes": [] }\n');
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
    'recipe:extract_surfaces',
    'recipe:decompose_surfaces',
  ]);
  const packet = readMapBuildRequest(projectRoot);
  // The request references the one canonical graph, never a `.unitbob` copy.
  assert.equal(packet.graph_path, join(projectRoot, 'graphify-out', 'graph.json'));
  assert.equal(packet.recipes.decompose.text, 'decompose recipe');
  assert.equal(packet.recipes.relate.text, 'relate recipe');
  assert.equal(packet.recipes.extract_surfaces.text, 'extract_surfaces recipe');
  assert.equal(packet.recipes.decompose_surfaces.text, 'decompose_surfaces recipe');
});

test('map-prepare succeeds with no LLM API key in the environment', async () => {
  const projectRoot = tmpProject();
  const before = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/_API_KEY$/.test(key)) delete process.env[key];
  }

  try {
    await mapPrepare(config(projectRoot), [], {
      ensureUnitbobIgnored: () => {},
      requireGraphify: async () => {},
      runGraphifyExtractKeyless: async () => {
        mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
        writeFileSync(join(projectRoot, 'graphify-out', 'graph.json'), '{ "nodes": [] }\n');
        return { stdout: '', stderr: '', code: 0 };
      },
      getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
    });
  } finally {
    Object.assign(process.env, before);
  }

  assert.equal(readMapBuildRequest(projectRoot).graph_path, join(projectRoot, 'graphify-out', 'graph.json'));
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
      runGraphifyExtractKeyless: async () => {
        mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
        writeFileSync(join(projectRoot, 'graphify-out', 'graph.json'), '{ "nodes": [] }\n');
        return { stdout: '', stderr: '', code: 0 };
      },
      getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
    });
  } finally {
    process.stdout.write = original;
  }

  const outputPath = join(projectRoot, '.unitbob', 'map-build', 'map_document.json');
  const surfaceOutputPath = join(projectRoot, '.unitbob', 'map-build', 'surface_document.json');
  assert.match(output, /Next: build BOTH lenses/);
  assert.ok(output.includes(outputPath), 'names the map output_path');
  assert.ok(output.includes(surfaceOutputPath), 'names the surface_output_path');
  assert.match(output, /recipes\.decompose, recipes\.relate/);
  assert.match(output, /recipes\.extract_surfaces/);
  assert.match(output, /recipes\.decompose_surfaces/);
  assert.match(output, /`unitbob put-map-build`/);
});

// Spec 32-7. The router is asked as part of preparing the build, not as a step
// of the workflow the host LLM could skip, and the request says plainly whether
// there is an inventory to copy from.
test('map-prepare hands the build request the route inventory when the router could be asked', async () => {
  const projectRoot = tmpProject();
  const inventoryPath = join(projectRoot, '.unitbob', 'map-build', 'route_inventory.json');
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
      runGraphifyExtractKeyless: async () => {
        mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
        writeFileSync(join(projectRoot, 'graphify-out', 'graph.json'), '{ "nodes": [] }\n');
        return { stdout: '', stderr: '', code: 0 };
      },
      extractRouteInventory: async () => ({
        status: 'written',
        path: inventoryPath,
        routes: 12,
        linked: 11,
        environment: 'test',
      }),
      getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
    });
  } finally {
    process.stdout.write = original;
  }

  assert.equal(readMapBuildRequest(projectRoot).route_inventory_path, inventoryPath);
  assert.match(output, /12 addresses from the router, 11 tied to a graph node/);
});

test('map-prepare leaves route_inventory_path out when the router said nothing', async () => {
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
      runGraphifyExtractKeyless: async () => {
        mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
        writeFileSync(join(projectRoot, 'graphify-out', 'graph.json'), '{ "nodes": [] }\n');
        return { stdout: '', stderr: '', code: 0 };
      },
      extractRouteInventory: async () => ({ status: 'silent', reason: 'unsupported_stack' }),
      getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
    });
  } finally {
    process.stdout.write = original;
  }

  // Absent, not empty: a stack with no router to ask is a normal outcome, and
  // the recipe reads the source as it always has.
  assert.equal('route_inventory_path' in readMapBuildRequest(projectRoot), false);
  assert.match(output, /No route inventory: this project has no router Unitbob can ask yet/);
});

test('map-prepare exits before recipes when graphify fails', async () => {
  const projectRoot = tmpProject();
  let fetchedRecipe = false;

  await assert.rejects(
    () =>
      mapPrepare(config(projectRoot), [], {
        ensureUnitbobIgnored: () => {},
        requireGraphify: async () => {},
        runGraphifyExtractKeyless: async () => ({ stdout: '', stderr: 'boom', code: 1 }),
        getRecipe: async (name) => {
          fetchedRecipe = true;
          return { name, version: 'v1', text: 'recipe' };
        },
      }),
    /graphify update failed: boom/,
  );

  assert.equal(fetchedRecipe, false);
});
