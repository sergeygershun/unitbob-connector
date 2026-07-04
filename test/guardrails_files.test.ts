import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeGuardrails, materializeHelper, UNITBOB_HELPER_RB } from '../src/files/guardrails.ts';

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

test('materializes the boot helper next to the suite', () => {
  const projectRoot = tmpProject();
  const dir = join(projectRoot, '.unitbob', 'guardrails');

  materializeGuardrails(projectRoot, { suite_digest: 'd1', spec_rb: 'suite' });

  assert.equal(readFileSync(join(dir, 'unitbob_helper.rb'), 'utf8'), UNITBOB_HELPER_RB);
});

test('materializeHelper writes the helper on its own (suite-build flow)', () => {
  const projectRoot = tmpProject();

  const helperPath = materializeHelper(projectRoot);

  assert.equal(helperPath, join(projectRoot, '.unitbob', 'guardrails', 'unitbob_helper.rb'));
  assert.equal(readFileSync(helperPath, 'utf8'), UNITBOB_HELPER_RB);
});

// The template is connector-owned Ruby nobody executes in these tests — pin the
// behaviourally load-bearing lines so an accidental edit fails loudly.
test('the helper delegates to the project rails_helper or self-boots the test env', () => {
  assert.match(UNITBOB_HELPER_RB, /File\.exist\?\(File\.join\(root, 'spec', 'rails_helper\.rb'\)\)/);
  assert.match(UNITBOB_HELPER_RB, /require 'rails_helper'/);
  assert.match(UNITBOB_HELPER_RB, /ENV\['RAILS_ENV'\] \|\|= 'test'/);
  assert.match(UNITBOB_HELPER_RB, /abort .+ unless Rails\.env\.test\?/);
  assert.match(UNITBOB_HELPER_RB, /maintain_test_schema!/);
  assert.match(UNITBOB_HELPER_RB, /use_transactional_fixtures = true/);
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
