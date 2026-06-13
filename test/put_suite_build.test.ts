import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputPath, writeSuiteBuildRequest } from '../src/files/suiteBuild.ts';
import { putSuiteBuild } from '../src/verbs/putSuiteBuild.ts';
import type { Config } from '../src/config.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-put-suite-build-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

function writeTask(projectRoot: string, mapDigest: string): void {
  writeSuiteBuildRequest(projectRoot, {
    map_digest: mapDigest,
    recipe: { name: 'generate', version: 'g1', text: 'g' },
    packets: [{ block: { id: 'block:billing' } }],
  });
}

test('put-suite-build uploads blocks with the map_digest taken from the task', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeTask(projectRoot, 'sha256-task');
  writeFileSync(outputPath(projectRoot), JSON.stringify({ blocks: [{ block_id: 'block:billing', covered: [], unguarded: [] }] }));

  let uploaded: unknown = null;
  await putSuiteBuild(config(projectRoot), [], {
    putSuiteBuild: async (payload) => {
      uploaded = payload;
      return { suite_version_id: 7, suite_digest: 'sha256-suite', map_url: 'http://host/repos/3', counts: { covered: 1 } };
    },
  });

  assert.deepEqual(uploaded, {
    map_digest: 'sha256-task',
    blocks: [{ block_id: 'block:billing', covered: [], unguarded: [] }],
  });
});

test('put-suite-build refuses to upload when the host output is unparseable', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeTask(projectRoot, 'sha256-task');
  writeFileSync(outputPath(projectRoot), 'sorry, here are your tests:');

  let uploaded = false;
  await assert.rejects(
    () =>
      putSuiteBuild(config(projectRoot), [], {
        putSuiteBuild: async () => {
          uploaded = true;
          throw new Error('should not upload');
        },
      }),
    /is not valid JSON/,
  );

  assert.equal(uploaded, false);
});
