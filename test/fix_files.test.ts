import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestPath, writeFixRequest } from '../src/files/fix.ts';
import type { FixPacket } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-fix-files-'));
}

test('writes the fix request with the repair prompt byte-identical to the packet', () => {
  const projectRoot = tmpProject();
  const packet: FixPacket = {
    interface_id: 'billing_charge',
    headline: 'Billing can still take a payment',
    failure_message: 'expected a captured payment',
    anchor: 'BillingService#charge',
    prompt: 'You are fixing a failed Unitbob check.\n\nFailed behavior:\nBilling can still take a payment',
    message: 'Ready to work on billing.',
  };

  const request = writeFixRequest(projectRoot, packet.interface_id, packet);
  const written = JSON.parse(readFileSync(requestPath(projectRoot), 'utf8'));

  assert.equal(request.prompt, packet.prompt);
  assert.equal(written.prompt, packet.prompt);
  assert.equal(written.test_body, undefined);
});
