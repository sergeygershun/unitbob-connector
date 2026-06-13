import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeGuardrails } from '../src/files/guardrails.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-guardrails-'));
}

test('materializes the suite and manifest under .unitbob/guardrails', () => {
  const projectRoot = tmpProject();
  const dir = join(projectRoot, '.unitbob', 'guardrails');

  materializeGuardrails(projectRoot, {
    suite_digest: 'd1',
    spec_rb: "RSpec.describe('x') {}\n",
    manifest: { guardrails_id: 'g1' },
  });

  assert.equal(readFileSync(join(dir, 'architecture_map_contracts_spec.rb'), 'utf8'), "RSpec.describe('x') {}\n");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'guardrails_manifest.json'), 'utf8')), { guardrails_id: 'g1' });
});

test('rewrites any existing local guardrail files before each run', () => {
  const projectRoot = tmpProject();
  const dir = join(projectRoot, '.unitbob', 'guardrails');

  materializeGuardrails(projectRoot, { suite_digest: 'd1', spec_rb: 'old', manifest: { old: true } });
  writeFileSync(join(dir, 'extra.txt'), 'stale');

  materializeGuardrails(projectRoot, { suite_digest: 'd2', spec_rb: 'new', manifest: { old: false } });

  assert.equal(readFileSync(join(dir, 'architecture_map_contracts_spec.rb'), 'utf8'), 'new');
  assert.equal(existsSync(join(dir, 'extra.txt')), false);
});
