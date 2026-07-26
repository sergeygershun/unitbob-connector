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
  const { mainPath } = materializeBehavioral(projectRoot, artifact(), 'cucumber');

  assert.equal(readFileSync(mainPath, 'utf8'), 'Feature: What the product does\n');
  assert.equal(
    readFileSync(join(projectRoot, BEHAVIORAL_DIR, 'step_definitions', 'surface_steps.rb'), 'utf8'),
    "Given('a shopper') {}\n",
  );
});

test('refuses a file that escapes the behavioral root and writes nothing', () => {
  const projectRoot = tmpProject();
  const escaped = { ...artifact(), path: 'features/pwned.feature' };

  assert.throws(() => materializeBehavioral(projectRoot, escaped, 'cucumber'), /\.unitbob\/behavioral\//);
  assert.equal(existsSync(join(projectRoot, BEHAVIORAL_DIR)), false);
});

test('wipes a stale file from a previous version before writing the new suite', () => {
  const projectRoot = tmpProject();
  const stale = join(projectRoot, BEHAVIORAL_DIR, 'features', 'old.feature');
  mkdirSync(join(projectRoot, BEHAVIORAL_DIR, 'features'), { recursive: true });
  writeFileSync(stale, 'Feature: the old one\n');

  materializeBehavioral(projectRoot, artifact(), 'cucumber');

  assert.equal(existsSync(stale), false);
  assert.equal(
    existsSync(join(projectRoot, BEHAVIORAL_DIR, 'features', 'surface_contracts.feature')),
    true,
  );
});

test('keeps only the Ruby runner environment when refreshing a Cucumber suite', () => {
  const projectRoot = tmpProject();
  const behavioralRoot = join(projectRoot, BEHAVIORAL_DIR);
  const sidecarGemfile = join(behavioralRoot, 'Gemfile');
  const sidecarLockfile = join(behavioralRoot, 'Gemfile.lock');
  const staleNodeModules = join(behavioralRoot, 'node_modules', 'stale');
  mkdirSync(behavioralRoot, { recursive: true });
  mkdirSync(staleNodeModules, { recursive: true });
  writeFileSync(sidecarGemfile, 'gem "cucumber", "9.2.1"\n');
  writeFileSync(sidecarLockfile, 'GEM\n');

  materializeBehavioral(projectRoot, artifact(), 'cucumber');

  assert.equal(readFileSync(sidecarGemfile, 'utf8'), 'gem "cucumber", "9.2.1"\n');
  assert.equal(readFileSync(sidecarLockfile, 'utf8'), 'GEM\n');
  assert.equal(existsSync(staleNodeModules), false);
});

test('keeps only the JavaScript runner environment when refreshing a Cucumber JS suite', () => {
  const projectRoot = tmpProject();
  const behavioralRoot = join(projectRoot, BEHAVIORAL_DIR);
  const sidecarPackage = join(behavioralRoot, 'package.json');
  const sidecarBin = join(behavioralRoot, 'node_modules', '.bin', 'cucumber-js');
  const staleVenv = join(behavioralRoot, '.venv', 'stale');
  mkdirSync(join(behavioralRoot, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(staleVenv, { recursive: true });
  writeFileSync(sidecarPackage, '{"private":true}\n');
  writeFileSync(sidecarBin, 'runner\n');

  materializeBehavioral(projectRoot, artifact(), 'cucumber-js');

  assert.equal(readFileSync(sidecarPackage, 'utf8'), '{"private":true}\n');
  assert.equal(readFileSync(sidecarBin, 'utf8'), 'runner\n');
  assert.equal(existsSync(staleVenv), false);
});

test('keeps only the Python runner environment when refreshing a pytest-bdd suite', () => {
  const projectRoot = tmpProject();
  const behavioralRoot = join(projectRoot, BEHAVIORAL_DIR);
  const sidecarPytest = join(behavioralRoot, '.venv', 'bin', 'pytest');
  const staleNodeModules = join(behavioralRoot, 'node_modules', 'stale');
  mkdirSync(join(behavioralRoot, '.venv', 'bin'), { recursive: true });
  mkdirSync(staleNodeModules, { recursive: true });
  writeFileSync(sidecarPytest, 'runner\n');

  materializeBehavioral(projectRoot, artifact(), 'pytest-bdd');

  assert.equal(readFileSync(sidecarPytest, 'utf8'), 'runner\n');
  assert.equal(existsSync(staleNodeModules), false);
});
