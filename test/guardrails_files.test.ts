import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeGuardrails } from '../src/files/guardrails.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-guardrails-'));
}

test('materializes the verbatim suite under .unitbob/guardrails', () => {
  const projectRoot = tmpProject();
  const dir = join(projectRoot, '.unitbob', 'guardrails');

  materializeGuardrails(projectRoot, {
    suite_digest: 'd1',
    spec_rb: "require 'rails_helper'\n\nRSpec.describe('x') {}\n",
  });

  assert.equal(
    readFileSync(join(dir, 'architecture_map_contracts_spec.rb'), 'utf8'),
    "require 'rails_helper'\n\nRSpec.describe('x') {}\n",
  );
  // test_metadata stays server-side — no manifest file is written.
  assert.equal(existsSync(join(dir, 'guardrails_manifest.json')), false);
});

test('rewrites any existing local guardrail files before each run', () => {
  const projectRoot = tmpProject();
  const dir = join(projectRoot, '.unitbob', 'guardrails');

  materializeGuardrails(projectRoot, { suite_digest: 'd1', spec_rb: 'old' });
  writeFileSync(join(dir, 'extra.txt'), 'stale');

  materializeGuardrails(projectRoot, { suite_digest: 'd2', spec_rb: 'new' });

  assert.equal(readFileSync(join(dir, 'architecture_map_contracts_spec.rb'), 'utf8'), 'new');
  assert.equal(existsSync(join(dir, 'extra.txt')), false);
});
