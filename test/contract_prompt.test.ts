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

// Spec 52-4, AC 1.3 / 7.1. A feature's checks have no lamp on the map to copy
// a digest from, so the feature's id stands in for it: `feature:<id>` is
// resolved to the digest of the feature's current checks through the same
// index `check` runs from.
test('contract-prompt takes feature:<id> in place of the digest and resolves it through the suite index', async () => {
  const seen: string[] = [];
  let output = '';

  await contractPrompt(config, ['feature:12', 'feature_12', 'fix'], {
    getSuiteIndex: async () => ({
      suites: [],
      feature_suites: [
        { feature_id: 15, feature_tag: 'unitbob_feature_15', suite_digest: 'feat-15', suite_file: { path: 'f', content: 'c' }, runner_manifest: { runner: 'cucumber' } },
        { feature_id: 12, feature_tag: 'unitbob_feature_12', suite_digest: 'feat-12', suite_file: { path: 'f', content: 'c' }, runner_manifest: { runner: 'cucumber' } },
      ],
    }),
    getContractPrompt: async (digest, testId, intent) => { seen.push(`${digest}:${testId}:${intent}`); return packet(intent); },
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  });

  assert.deepEqual(seen, ['feat-12:feature_12:fix']);
  assert.match(output, /Ready to work on/);
});

test('contract-prompt says so in one line when no red feature has that id, asking the server nothing else', async () => {
  let fetched = false;

  await assert.rejects(
    () => contractPrompt(config, ['feature:12', 'feature_12'], {
      getSuiteIndex: async () => ({ suites: [], feature_suites: [] }),
      getContractPrompt: async () => { fetched = true; return packet('fix'); },
      stdout: { write: () => true },
    }),
    /No feature 12 has checks to act on — it is not being built, or it is finished\./,
  );
  assert.equal(fetched, false);
});
