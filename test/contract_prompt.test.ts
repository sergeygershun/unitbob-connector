import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractPrompt } from '../src/verbs/contractPrompt.ts';
import type { Config } from '../src/config.ts';
import type { ContractPrompt } from '../src/wire.ts';

const config: Config = { server: 'https://host', repoId: 3, projectRoot: '/tmp/x' };

function packet(intent: string): ContractPrompt {
  return {
    suite_digest: 'behav-d1',
    suite_kind: 'behavioral',
    test_id: 'checkout',
    intent,
    headline: 'A shopper can pay',
    failure_message: 'the order was never confirmed',
    prompt: `You are acting on a failed Unitbob check (${intent}).`,
    message: 'Ready to work on «A shopper can pay».',
  };
}

test('contract-prompt fetches the brief for a digest+test_id+intent and prints message then prompt', async () => {
  const seen: string[] = [];
  let output = '';

  await contractPrompt(config, ['behav-d1', 'checkout', 'accept'], {
    getContractPrompt: async (digest, testId, intent) => {
      seen.push(`${digest}:${testId}:${intent}`);
      return packet(intent);
    },
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  });

  assert.deepEqual(seen, ['behav-d1:checkout:accept']);
  assert.match(output, /Ready to work on «A shopper can pay»/);
  assert.match(output, /You are acting on a failed Unitbob check \(accept\)/);
});

test('contract-prompt defaults the intent to fix', async () => {
  let intentSeen = '';
  await contractPrompt(config, ['behav-d1', 'checkout'], {
    getContractPrompt: async (_digest, _testId, intent) => { intentSeen = intent; return packet(intent); },
    stdout: { write: () => true },
  });
  assert.equal(intentSeen, 'fix');
});

test('contract-prompt requires a digest and a test_id', async () => {
  await assert.rejects(() => contractPrompt(config, ['behav-d1'], {
    getContractPrompt: async () => packet('fix'),
    stdout: { write: () => true },
  }), /Usage: unitbob contract-prompt/);
});

test('contract-prompt rejects an unknown intent before any request', async () => {
  let fetched = false;
  await assert.rejects(() => contractPrompt(config, ['d', 't', 'rewrite'], {
    getContractPrompt: async () => { fetched = true; return packet('rewrite'); },
    stdout: { write: () => true },
  }), /intent must be "fix" or "accept"/);
  assert.equal(fetched, false);
});
