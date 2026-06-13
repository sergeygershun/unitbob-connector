import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixPrepare } from '../src/verbs/fixPrepare.ts';
import { requestPath } from '../src/files/fix.ts';
import type { Config } from '../src/config.ts';
import type { FixPacket } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-fix-prepare-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

const packet: FixPacket = {
  headline: 'Billing can still take a payment',
  test_body: 'expect(true).to be true',
  failure_message: 'expected /charge/ to match',
  anchor: 'BillingService#charge',
  message: 'Ready to fix «Billing can still take a payment».',
};

test('fix-prepare fetches the per-test packet and writes the task with no output file', async () => {
  const projectRoot = tmpProject();
  const out: string[] = [];
  let requestedId = '';

  await fixPrepare(config(projectRoot), ['guard-1'], {
    getFixPacket: async (id) => {
      requestedId = id;
      return packet;
    },
    stdout: { write: (chunk) => out.push(String(chunk)) },
  });

  assert.equal(requestedId, 'guard-1');
  const written = JSON.parse(readFileSync(requestPath(projectRoot), 'utf8'));
  assert.equal(written.project_root, projectRoot);
  assert.equal(written.test_id, 'guard-1');
  assert.equal(written.headline, packet.headline);
  assert.equal(written.test_body, packet.test_body);
  assert.equal(written.anchor, 'BillingService#charge');
  // Rails authors the user-facing line; the connector echoes it verbatim.
  assert.ok(out.join('').includes(packet.message));
  // No answer/output file path exists for Fix — the host edits code in place.
  assert.ok(!existsSync(join(projectRoot, '.unitbob', 'fix', 'fix_output.json')));
});

test('fix-prepare requires a test_id', async () => {
  const projectRoot = tmpProject();
  await assert.rejects(() => fixPrepare(config(projectRoot), [], { getFixPacket: async () => packet }), /Usage/);
});

test('fix-prepare writes nothing when the server refuses the target', async () => {
  const projectRoot = tmpProject();
  await assert.rejects(
    () =>
      fixPrepare(config(projectRoot), ['guard-1'], {
        getFixPacket: async () => {
          throw new Error('GET /repos/3/fix_packet failed: 422 — That check is not failing.');
        },
      }),
    /not failing/,
  );
  assert.ok(!existsSync(requestPath(projectRoot)));
});
