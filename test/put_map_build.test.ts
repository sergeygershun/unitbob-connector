import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
