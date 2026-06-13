import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reshapePrepare } from '../src/verbs/reshapePrepare.ts';
import { readReshapeRequest, requestPath } from '../src/files/reshape.ts';
import type { Config } from '../src/config.ts';
import type { ReshapePacket } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-reshape-prepare-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

const packet: ReshapePacket = {
  recipe: { name: 'generate', version: 'g1', text: 'generate recipe' },
  packet: { block: { id: 'block:billing' } },
  suite_digest: 'sha256-suite',
};

test('reshape-prepare writes the task with the bundled recipe, packet and suite_digest', async () => {
  const projectRoot = tmpProject();
  let requestedId = '';

  await reshapePrepare(config(projectRoot), ['guard-1'], {
    getReshapePacket: async (id) => {
      requestedId = id;
      return packet;
    },
    stdout: { write: () => true },
  });

  assert.equal(requestedId, 'guard-1');
  const request = readReshapeRequest(projectRoot);
  assert.equal(request.test_id, 'guard-1');
  assert.equal(request.suite_digest, 'sha256-suite');
  assert.equal(request.recipe.text, 'generate recipe');
  assert.deepEqual(request.packet, { block: { id: 'block:billing' } });
  assert.ok(request.output_path.endsWith(join('.unitbob', 'reshape', 'reshape_output.json')));
});

test('reshape-prepare surfaces a 409 (code gone) and writes nothing', async () => {
  const projectRoot = tmpProject();

  await assert.rejects(
    () =>
      reshapePrepare(config(projectRoot), ['guard-1'], {
        getReshapePacket: async () => {
          throw new Error('The code this test guards is no longer in the map — retire instead.');
        },
      }),
    /retire instead/,
  );
  assert.ok(!existsSync(requestPath(projectRoot)));
});

test('reshape-prepare requires a test_id', async () => {
  const projectRoot = tmpProject();
  await assert.rejects(
    () => reshapePrepare(config(projectRoot), [], { getReshapePacket: async () => packet }),
    /Usage/,
  );
});
