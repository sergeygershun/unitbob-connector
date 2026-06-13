import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '../src/verbs/analyze.ts';
import type { Config } from '../src/config.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-analyze-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

test('missing graphify exits before graph extraction and upload', async () => {
  const projectRoot = tmpProject();
  let extracted = false;
  let uploaded = false;

  await assert.rejects(
    () =>
      analyze(config(projectRoot), [], {
        requireGraphify: async () => {
          throw new Error('graphify is required');
        },
        runGraphifyExtract: async () => {
          extracted = true;
          return { stdout: '', stderr: '', code: 0 };
        },
        putGraph: async () => {
          uploaded = true;
          return { graph_digest: 'digest' };
        },
      }),
    /graphify is required/,
  );

  assert.equal(extracted, false);
  assert.equal(uploaded, false);
});

test('non-zero graphify exit does not upload', async () => {
  const projectRoot = tmpProject();
  let uploaded = false;

  await assert.rejects(
    () =>
      analyze(config(projectRoot), [], {
        requireGraphify: async () => {},
        runGraphifyExtract: async () => ({ stdout: '', stderr: 'boom', code: 1 }),
        putGraph: async () => {
          uploaded = true;
          return { graph_digest: 'digest' };
        },
      }),
    /graphify extract failed: boom/,
  );

  assert.equal(uploaded, false);
});

test('missing graph.json does not upload', async () => {
  const projectRoot = tmpProject();
  let uploaded = false;

  await assert.rejects(
    () =>
      analyze(config(projectRoot), [], {
        requireGraphify: async () => {},
        runGraphifyExtract: async () => ({ stdout: '', stderr: '', code: 0 }),
        putGraph: async () => {
          uploaded = true;
          return { graph_digest: 'digest' };
        },
      }),
    /did not write .*graph\.json/,
  );

  assert.equal(uploaded, false);
});

test('successful analyze ignores .unitbob, uploads raw graph, and prints digest', async () => {
  const projectRoot = tmpProject();
  const graphDir = join(projectRoot, '.unitbob', 'graphify-out');
  mkdirSync(graphDir, { recursive: true });
  const rawGraphJson = '{\n  "nodes": [{ "id": "a" }]\n}\n';
  writeFileSync(join(graphDir, 'graph.json'), rawGraphJson);

  let uploaded: string | null = null;
  let ignoredRoot = '';

  await analyze(config(projectRoot), [], {
    ensureUnitbobIgnored: (root) => {
      ignoredRoot = root;
      writeFileSync(join(root, '.graphifyignore'), '.unitbob/\n');
    },
    requireGraphify: async () => {},
    runGraphifyExtract: async () => ({ stdout: '', stderr: '', code: 0 }),
    putGraph: async (graph) => {
      uploaded = graph;
      return { graph_digest: 'sha256:abc' };
    },
  });

  assert.equal(ignoredRoot, projectRoot);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'graphify-out', 'graph.json')), true);
  assert.equal(readFileSync(join(projectRoot, '.graphifyignore'), 'utf8'), '.unitbob/\n');
  assert.equal(uploaded, rawGraphJson);
});
