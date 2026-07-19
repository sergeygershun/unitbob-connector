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

const okStack = () => ({ ok: true });

function hostOutput(): Record<string, unknown> {
  return {
    suite_file: {
      path: '.unitbob/guardrails/architecture_map_contracts_spec.rb',
      content: "require 'rails_helper'\n\nRSpec.describe 'x' do\nend\n",
    },
    runner_manifest: { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' },
    test_metadata: { capabilities: [{ interface_id: 'billing_charge', status: 'unguarded', reason: 'no boundary' }] },
  };
}

test('put-suite-build uploads the whole suite artifact with the map_digest from the task', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeTask(projectRoot, 'sha256-task');
  const output = hostOutput();
  writeFileSync(outputPath(projectRoot), JSON.stringify(output));

  let uploaded: unknown = null;
  await putSuiteBuild(config(projectRoot), [], {
    validateStack: okStack,
    putSuiteBuild: async (payload) => {
      uploaded = payload;
      return { suite_version_id: 7, suite_digest: 'sha256-suite', map_url: 'http://host/repos/3', counts: { covered: 0 } };
    },
  });

  assert.deepEqual(uploaded, {
    map_digest: 'sha256-task',
    suite_file: output.suite_file,
    runner_manifest: output.runner_manifest,
    test_metadata: output.test_metadata,
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
        validateStack: okStack,
        putSuiteBuild: async () => {
          uploaded = true;
          throw new Error('should not upload');
        },
      }),
    /is not valid JSON/,
  );

  assert.equal(uploaded, false);
});

test('put-suite-build fails closed on a stack mismatch and uploads nothing', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeTask(projectRoot, 'sha256-task');
  writeFileSync(outputPath(projectRoot), JSON.stringify(hostOutput()));

  let uploaded = false;
  await assert.rejects(
    () =>
      putSuiteBuild(config(projectRoot), [], {
        validateStack: (_root, runner) => ({
          ok: false,
          message: `The ${runner} stack was selected, but local markers do not confirm it.`,
        }),
        putSuiteBuild: async () => {
          uploaded = true;
          throw new Error('should not upload');
        },
      }),
    /local markers do not confirm/,
  );

  assert.equal(uploaded, false);
});

test('put-suite-build validates the runner named by the host output', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeTask(projectRoot, 'sha256-task');
  const output = hostOutput();
  output.runner_manifest = { language: 'javascript', framework: 'vitest', result_format: 'vitest_json', runner: 'vitest' };
  (output.suite_file as Record<string, unknown>).path = '.unitbob/guardrails/architecture_map_contracts.test.ts';
  writeFileSync(outputPath(projectRoot), JSON.stringify(output));

  const seen: string[] = [];
  await putSuiteBuild(config(projectRoot), [], {
    validateStack: (_root, runner) => {
      seen.push(runner);
      return { ok: true };
    },
    putSuiteBuild: async () => (
      { suite_version_id: 7, suite_digest: 's', map_url: 'http://host/repos/3', counts: {} }
    ),
  });

  assert.deepEqual(seen, ['vitest']);
});
