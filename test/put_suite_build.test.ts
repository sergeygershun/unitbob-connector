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
    blocks: [{ block_id: 'billing', interfaces: [] }],
  });
}

test('put-suite-build uploads the whole spec file + test_metadata with the map_digest from the task', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeTask(projectRoot, 'sha256-task');
  const specRb = "require 'rails_helper'\n\nRSpec.describe 'x' do\nend\n";
  const testMetadata = { capabilities: [{ interface_id: 'billing_charge', status: 'unguarded', reason: 'no boundary' }] };
  writeFileSync(outputPath(projectRoot), JSON.stringify({ spec_rb: specRb, test_metadata: testMetadata }));

  let uploaded: unknown = null;
  await putSuiteBuild(config(projectRoot), [], {
    putSuiteBuild: async (payload) => {
      uploaded = payload;
      return { suite_version_id: 7, suite_digest: 'sha256-suite', map_url: 'http://host/repos/3', counts: { covered: 0 } };
    },
  });

  assert.deepEqual(uploaded, {
    map_digest: 'sha256-task',
    spec_rb: specRb,
    test_metadata: testMetadata,
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
