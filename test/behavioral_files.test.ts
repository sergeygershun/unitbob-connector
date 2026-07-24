import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BEHAVIORAL_DIR, materializeBehavioral } from '../src/files/behavioral.ts';
import type { SuiteArtifact } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-behavioral-'));
}

function artifact(): SuiteArtifact {
  return {
    path: '.unitbob/behavioral/features/surface_contracts.feature',
    content: 'Feature: What the product does\n',
    support_files: [
      { path: '.unitbob/behavioral/step_definitions/surface_steps.rb', content: "Given('a shopper') {}\n" },
    ],
  };
}

test('materializes the .feature and every support file under the behavioral root', () => {
  const projectRoot = tmpProject();
  const { mainPath } = materializeBehavioral(projectRoot, artifact());

  assert.equal(readFileSync(mainPath, 'utf8'), 'Feature: What the product does\n');
  assert.equal(
    readFileSync(join(projectRoot, BEHAVIORAL_DIR, 'step_definitions', 'surface_steps.rb'), 'utf8'),
    "Given('a shopper') {}\n",
  );
});

test('refuses a file that escapes the behavioral root and writes nothing', () => {
  const projectRoot = tmpProject();
  const escaped = { ...artifact(), path: 'features/pwned.feature' };

  assert.throws(() => materializeBehavioral(projectRoot, escaped), /\.unitbob\/behavioral\//);
  assert.equal(existsSync(join(projectRoot, BEHAVIORAL_DIR)), false);
});

test('wipes a stale file from a previous version before writing the new suite', () => {
  const projectRoot = tmpProject();
  const stale = join(projectRoot, BEHAVIORAL_DIR, 'features', 'old.feature');
  mkdirSync(join(projectRoot, BEHAVIORAL_DIR, 'features'), { recursive: true });
  writeFileSync(stale, 'Feature: the old one\n');

  materializeBehavioral(projectRoot, artifact());

  assert.equal(existsSync(stale), false);
  assert.equal(
    existsSync(join(projectRoot, BEHAVIORAL_DIR, 'features', 'surface_contracts.feature')),
    true,
  );
});
