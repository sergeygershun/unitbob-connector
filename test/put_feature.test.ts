import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { putFeature } from '../src/verbs/putFeature.ts';
import { outputPath } from '../src/files/featureStart.ts';
import type { Config } from '../src/config.ts';
import { WireError, type FeatureUpload } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-put-feature-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, token: 'secret', projectRoot };
}

function writeAnswer(projectRoot: string, answer: unknown): void {
  const path = outputPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(answer));
}

test('put-feature sends the answer in the wire shape and prints the sentence and the link', async () => {
  const projectRoot = tmpProject();
  writeAnswer(projectRoot, {
    title: 'Comments on posts',
    intent: 'I want to add comments to posts',
    affected: [{ id: 'posts', why: 'A comment lives on the post page.' }],
  });
  const out: string[] = [];
  let sent: FeatureUpload | null = null;

  await putFeature(config(projectRoot), [], {
    postFeature: async (payload) => {
      sent = payload;
      return {
        feature_id: 7,
        url: '/repos/3/features/7',
        message: 'Feature recorded: "Comments on posts". 1 capability to watch.',
      };
    },
    stdout: { write: (chunk) => out.push(String(chunk)) },
  });

  assert.deepEqual(sent, {
    title: 'Comments on posts',
    intent: 'I want to add comments to posts',
    affected: [{ id: 'posts', why: 'A comment lives on the post page.' }],
  });
  const lines = out.join('').trim().split('\n');
  assert.equal(lines[0], 'Feature recorded: "Comments on posts". 1 capability to watch.');
  // Through the exchanger, like every printed link (spec 33).
  assert.equal(lines[1], 'https://host/repos/3/enter?next=%2Frepos%2F3%2Ffeatures%2F7#t=secret');
});

test('put-feature lets the 422 with both id lists through, unchanged', async () => {
  const projectRoot = tmpProject();
  writeAnswer(projectRoot, { title: 'x', intent: 'y', affected: [{ id: 'comments', why: '' }] });

  await assert.rejects(
    () =>
      putFeature(config(projectRoot), [], {
        postFeature: async () => {
          throw new WireError('422 — {"unknown_ids":["comments"],"known_ids":["posts"]}');
        },
      }),
    /unknown_ids.*known_ids/,
  );
});

test('put-feature stops on a malformed answer before touching the wire', async () => {
  const projectRoot = tmpProject();
  writeAnswer(projectRoot, { title: 'x', affected: [] });
  let called = false;

  await assert.rejects(
    () =>
      putFeature(config(projectRoot), [], {
        postFeature: async () => {
          called = true;
          throw new Error('unreachable');
        },
      }),
    /"intent"/,
  );
  assert.equal(called, false);
});
