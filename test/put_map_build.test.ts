import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeMapBuildRequest,
  graphPath,
  outputPath,
  surfacesPath,
  surfaceOutputPath,
} from '../src/files/mapBuild.ts';
import { putMapBuild } from '../src/verbs/putMapBuild.ts';
import type { Config } from '../src/config.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-put-map-build-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

const RECIPES = {
  decompose: { name: 'decompose', version: 'd1', text: 'd' },
  relate: { name: 'relate', version: 'r1', text: 'r' },
  extract_surfaces: { name: 'extract_surfaces', version: 'e1', text: 'e' },
  decompose_surfaces: { name: 'decompose_surfaces', version: 's1', text: 's' },
};

const uploadResult = {
  map_version_id: 1,
  map_digest: 'map',
  surface_digest: 'surface',
  graph_digest: 'graph',
  map_url: 'http://host/repos/3/map',
  reused: false,
};

test('put-map-build reads request and both lenses, then uploads the full bundle', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'map-build'), { recursive: true });
  writeFileSync(graphPath(projectRoot), '{ "nodes": [] }\n');
  writeFileSync(outputPath(projectRoot), '{ "version": 3 }\n');
  writeFileSync(surfacesPath(projectRoot), '{ "surfaces": [] }\n');
  writeFileSync(surfaceOutputPath(projectRoot), '{ "version": 1 }\n');
  writeMapBuildRequest(projectRoot, RECIPES);

  let uploaded: unknown = null;
  await putMapBuild(config(projectRoot), [], {
    putMapBuild: async (payload) => {
      uploaded = payload;
      return uploadResult;
    },
  });

  assert.deepEqual(uploaded, {
    graph: { nodes: [] },
    map_document: { version: 3 },
    surfaces: { surfaces: [] },
    surface_document: { version: 1 },
  });
});

test('put-map-build rejects a missing map lens before upload', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
  writeFileSync(graphPath(projectRoot), '{ "nodes": [] }\n');
  writeMapBuildRequest(projectRoot, RECIPES);

  let uploaded = false;
  await assert.rejects(
    () =>
      putMapBuild(config(projectRoot), [], {
        putMapBuild: async () => {
          uploaded = true;
          throw new Error('should not upload');
        },
      }),
    /map_document\.json not found/,
  );

  assert.equal(uploaded, false);
});

test('put-map-build rejects a missing surface lens before upload', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'map-build'), { recursive: true });
  writeFileSync(graphPath(projectRoot), '{ "nodes": [] }\n');
  writeFileSync(outputPath(projectRoot), '{ "version": 3 }\n');
  writeFileSync(surfacesPath(projectRoot), '{ "surfaces": [] }\n');
  // surface_document.json deliberately absent — no partial bundle may upload.
  writeMapBuildRequest(projectRoot, RECIPES);

  let uploaded = false;
  await assert.rejects(
    () =>
      putMapBuild(config(projectRoot), [], {
        putMapBuild: async () => {
          uploaded = true;
          throw new Error('should not upload');
        },
      }),
    /surface_document\.json not found/,
  );

  assert.equal(uploaded, false);
});

// Spec 32-7, review finding. Where the router was asked, the addresses are a
// fact we already hold, and the map must carry those and no others. Holding the
// answer to it here — while both files are on this machine — is the same move
// spec 32-6 made for suites, and it replaces a rule that until now lived only
// as a sentence in a prompt.
function builtWithRouterInventory(routes: string[], written: string[]): string {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'map-build'), { recursive: true });
  writeFileSync(graphPath(projectRoot), '{ "nodes": [] }\n');
  writeFileSync(outputPath(projectRoot), '{ "version": 3 }\n');
  writeFileSync(surfaceOutputPath(projectRoot), '{ "version": 1 }\n');

  const surfaces = (ids: string[]) => ids.map((id) => ({ kind: 'route', id }));
  const inventoryPath = join(projectRoot, '.unitbob', 'map-build', 'route_inventory.json');
  writeFileSync(inventoryPath, JSON.stringify({ declared_by: 'rails routes', surfaces: surfaces(routes) }));
  writeFileSync(surfacesPath(projectRoot), JSON.stringify({ surfaces: surfaces(written) }));
  writeMapBuildRequest(projectRoot, RECIPES, inventoryPath);
  return projectRoot;
}

test('put-map-build uploads when every address the router declared is on the map', async () => {
  const projectRoot = builtWithRouterInventory(['GET /settings', 'POST /checkout'], ['POST /checkout', 'GET /settings']);

  let uploaded = false;
  await putMapBuild(config(projectRoot), [], {
    putMapBuild: async () => {
      uploaded = true;
      return uploadResult;
    },
  });

  assert.equal(uploaded, true, 'order is not a difference');
});

test('put-map-build refuses a map that invented an address the router never declared', async () => {
  const projectRoot = builtWithRouterInventory(['GET /settings'], ['GET /settings', 'GET /work_time']);

  let uploaded = false;
  await assert.rejects(
    () =>
      putMapBuild(config(projectRoot), [], {
        putMapBuild: async () => {
          uploaded = true;
          return uploadResult;
        },
      }),
    /never declared: GET \/work_time/,
  );

  assert.equal(uploaded, false, 'nothing is sent, so the previous map stays current');
});

test('put-map-build refuses a map that dropped or renamed an address', async () => {
  const projectRoot = builtWithRouterInventory(['GET /settings', 'POST /checkout'], ['GET /settings']);

  await assert.rejects(
    () => putMapBuild(config(projectRoot), [], { putMapBuild: async () => uploadResult }),
    /missing 1 address the router declared: POST \/checkout/,
  );
});

test('put-map-build refuses when the request names an inventory that is gone', async () => {
  const projectRoot = builtWithRouterInventory(['GET /settings'], ['GET /settings']);
  rmSync(join(projectRoot, '.unitbob', 'map-build', 'route_inventory.json'));

  await assert.rejects(
    () => putMapBuild(config(projectRoot), [], { putMapBuild: async () => uploadResult }),
    /named by the build request but is not there.*map-prepare/s,
  );
});

// Every stack we cannot ask, and every application that would not load, arrives
// here with no inventory. Those uploads must pass exactly as before.
test('put-map-build holds nothing against a build that had no router to ask', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'map-build'), { recursive: true });
  writeFileSync(graphPath(projectRoot), '{ "nodes": [] }\n');
  writeFileSync(outputPath(projectRoot), '{ "version": 3 }\n');
  writeFileSync(surfaceOutputPath(projectRoot), '{ "version": 1 }\n');
  writeFileSync(surfacesPath(projectRoot), '{ "surfaces": [{ "kind": "route", "id": "GET /whatever" }] }');
  writeMapBuildRequest(projectRoot, RECIPES);

  let uploaded = false;
  await putMapBuild(config(projectRoot), [], {
    putMapBuild: async () => {
      uploaded = true;
      return uploadResult;
    },
  });

  assert.equal(uploaded, true);
});

// Spec 32-7, Task 1.11. The recipe builds `surfaces.json` out of the router's
// answer with one command, and from that second on the file looks finished. The
// three kinds no router declares are found only if the model keeps working, and
// until now nothing but a sentence in the recipe asked it to. A project that
// keeps a schema and reports no table did not keep working.
function builtWithSchema(surfaces: unknown[], schema: string | null): string {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'map-build'), { recursive: true });
  if (schema) {
    mkdirSync(join(projectRoot, 'db'), { recursive: true });
    writeFileSync(join(projectRoot, 'db', schema), 'create_table "transactions"\n');
  }
  writeFileSync(graphPath(projectRoot), '{ "nodes": [] }\n');
  writeFileSync(outputPath(projectRoot), '{ "version": 3 }\n');
  writeFileSync(surfaceOutputPath(projectRoot), '{ "version": 1 }\n');
  writeFileSync(surfacesPath(projectRoot), JSON.stringify({ surfaces }));
  writeMapBuildRequest(projectRoot, RECIPES);
  return projectRoot;
}

test('put-map-build refuses an inventory of routes only when the project keeps a schema', async () => {
  const projectRoot = builtWithSchema([{ kind: 'route', id: 'GET /settings' }], 'schema.rb');

  let uploaded = false;
  await assert.rejects(
    () =>
      putMapBuild(config(projectRoot), [], {
        putMapBuild: async () => {
          uploaded = true;
          return uploadResult;
        },
      }),
    /no `table` surface.*db\/schema\.rb/s,
  );

  assert.equal(uploaded, false, 'a map with no table at all is not finished');
});

test('put-map-build reads db/structure.sql as the same statement about storage', async () => {
  const projectRoot = builtWithSchema([{ kind: 'route', id: 'GET /settings' }], 'structure.sql');

  await assert.rejects(
    () => putMapBuild(config(projectRoot), [], { putMapBuild: async () => uploadResult }),
    /db\/structure\.sql/,
  );
});

test('put-map-build uploads once the tables are there beside the routes', async () => {
  const projectRoot = builtWithSchema(
    [
      { kind: 'route', id: 'GET /settings' },
      { kind: 'table', id: 'transactions', source_file: 'db/schema.rb' },
    ],
    'schema.rb',
  );

  let uploaded = false;
  await putMapBuild(config(projectRoot), [], {
    putMapBuild: async () => {
      uploaded = true;
      return uploadResult;
    },
  });

  assert.equal(uploaded, true);
});

// A project with nothing on disk claiming it stores anything is entitled to a
// map with no tables — a static site, a library. We hold nobody to a fact we
// cannot read.
test('put-map-build asks for no table when no schema is on disk', async () => {
  const projectRoot = builtWithSchema([{ kind: 'route', id: 'GET /settings' }], null);

  let uploaded = false;
  await putMapBuild(config(projectRoot), [], {
    putMapBuild: async () => {
      uploaded = true;
      return uploadResult;
    },
  });

  assert.equal(uploaded, true);
});
