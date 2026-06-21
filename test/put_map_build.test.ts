import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMapBuildRequest, graphPath, outputPath } from '../src/files/mapBuild.ts';
import { putMapBuild } from '../src/verbs/putMapBuild.ts';
import type { Config } from '../src/config.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-put-map-build-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

test('put-map-build reads request and host output, then uploads graph plus map', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'map-build'), { recursive: true });
  writeFileSync(graphPath(projectRoot), '{ "nodes": [] }\n');
  writeFileSync(outputPath(projectRoot), '{ "version": 3 }\n');
  writeMapBuildRequest(projectRoot, {
    decompose: { name: 'decompose', version: 'd1', text: 'd' },
    relate: { name: 'relate', version: 'r1', text: 'r' },
  });

  let uploaded: unknown = null;
  await putMapBuild(config(projectRoot), [], {
    putMapBuild: async (payload) => {
      uploaded = payload;
      return {
        map_version_id: 1,
        map_digest: 'map',
        graph_digest: 'graph',
        map_url: 'http://host/repos/3/map',
        reused: false,
      };
    },
  });

  assert.deepEqual(uploaded, { graph: { nodes: [] }, map_document: { version: 3 } });
});

test('put-map-build rejects missing or invalid host output before upload', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
  writeFileSync(graphPath(projectRoot), '{ "nodes": [] }\n');
  writeMapBuildRequest(projectRoot, {
    decompose: { name: 'decompose', version: 'd1', text: 'd' },
    relate: { name: 'relate', version: 'r1', text: 'r' },
  });

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
