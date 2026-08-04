import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRunner, type ProvisionDeps } from '../src/runner/provision.ts';

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-provision-test-'));
  writeFileSync(join(dir, 'Gemfile'), 'source "https://rubygems.org"\ngem "rails", "5.2.0"\n');
  writeFileSync(join(dir, 'package.json'), '{"name":"test-app"}\n');
  writeFileSync(join(dir, 'requirements.txt'), 'flask==2.0.0\n');
  return dir;
}

test('ensureRunner for Ruby generates sidecar Gemfile and does not touch root Gemfile', async () => {
  const projectRoot = tmpProject();
  const rootGemfileBefore = readFileSync(join(projectRoot, 'Gemfile'), 'utf8');

  const mockDeps: ProvisionDeps = {
    runCmd: async (cmd, args) => {
      assert.equal(cmd, 'bundle');
      assert.deepEqual(args, ['install']);
      return { code: 0, stdout: 'Bundle complete', stderr: '' };
    },
  };

  const result = await ensureRunner(projectRoot, 'cucumber', mockDeps);
  assert.equal(result.status, 'provisioned');

  // Verify sidecar Gemfile
  const sidecarGemfile = join(projectRoot, '.unitbob', 'behavioral', 'Gemfile');
  assert.ok(existsSync(sidecarGemfile));
  const sidecarContent = readFileSync(sidecarGemfile, 'utf8');
  assert.match(sidecarContent, /eval_gemfile/);
  assert.match(sidecarContent, /gem "cucumber"/);

  // Verify root Gemfile remains untouched byte-for-byte
  const rootGemfileAfter = readFileSync(join(projectRoot, 'Gemfile'), 'utf8');
  assert.equal(rootGemfileBefore, rootGemfileAfter);
});

// The sidecar must resolve *from* the project's lock, not beside it. Resolving
// from scratch moved 285 gems on a2time and left the branch unable to load Rails.
test('ensureRunner for Ruby seeds the sidecar lock from the project before installing', async () => {
  const projectRoot = tmpProject();
  const projectLock = 'GEM\n  specs:\n    carrierwave (2.2.6)\n';
  writeFileSync(join(projectRoot, 'Gemfile.lock'), projectLock);
  const sidecarLock = join(projectRoot, '.unitbob', 'behavioral', 'Gemfile.lock');

  let lockWhenBundlerRan: string | null = null;
  const mockDeps: ProvisionDeps = {
    runCmd: async () => {
      // Read inside the call: seeding after `bundle install` would be no seeding.
      lockWhenBundlerRan = existsSync(sidecarLock) ? readFileSync(sidecarLock, 'utf8') : null;
      return { code: 0, stdout: '', stderr: '' };
    },
  };

  const result = await ensureRunner(projectRoot, 'cucumber', mockDeps);
  assert.equal(result.status, 'provisioned');
  assert.equal(lockWhenBundlerRan, projectLock);
  assert.equal(readFileSync(join(projectRoot, 'Gemfile.lock'), 'utf8'), projectLock);
});

// A lock seeded once goes stale as soon as the project upgrades a gem: the
// sidecar Gemfile inherits the project's Gemfile, never its lock.
test('ensureRunner for Ruby refreshes a sidecar lock that has fallen behind the project', async () => {
  const projectRoot = tmpProject();
  const sidecarLock = join(projectRoot, '.unitbob', 'behavioral', 'Gemfile.lock');
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral'), { recursive: true });
  writeFileSync(sidecarLock, 'GEM\n  specs:\n    carrierwave (2.2.0)\n');
  writeFileSync(join(projectRoot, 'Gemfile.lock'), 'GEM\n  specs:\n    carrierwave (2.2.6)\n');

  const mockDeps: ProvisionDeps = { runCmd: async () => ({ code: 0, stdout: '', stderr: '' }) };

  await ensureRunner(projectRoot, 'cucumber', mockDeps);
  assert.match(readFileSync(sidecarLock, 'utf8'), /carrierwave \(2\.2\.6\)/);
});

// No lock to copy is not a failure — bundler resolves as it always did.
test('ensureRunner for Ruby provisions a project that has no lock at all', async () => {
  const projectRoot = tmpProject();

  const mockDeps: ProvisionDeps = { runCmd: async () => ({ code: 0, stdout: '', stderr: '' }) };

  const result = await ensureRunner(projectRoot, 'cucumber', mockDeps);
  assert.equal(result.status, 'provisioned');
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'behavioral', 'Gemfile.lock')), false);
});

test('ensureRunner for JS generates sidecar package.json and leaves root package.json untouched', async () => {
  const projectRoot = tmpProject();
  const rootPkgBefore = readFileSync(join(projectRoot, 'package.json'), 'utf8');

  const mockDeps: ProvisionDeps = {
    runCmd: async (cmd, args) => {
      assert.equal(cmd, 'npm');
      assert.deepEqual(args, ['install', '--prefix', '.unitbob/behavioral']);
      return { code: 0, stdout: 'Installed', stderr: '' };
    },
  };

  const result = await ensureRunner(projectRoot, 'cucumber-js', mockDeps);
  assert.equal(result.status, 'provisioned');

  const sidecarPkg = join(projectRoot, '.unitbob', 'behavioral', 'package.json');
  assert.ok(existsSync(sidecarPkg));
  const sidecarJson = JSON.parse(readFileSync(sidecarPkg, 'utf8'));
  assert.ok(sidecarJson.devDependencies['@cucumber/cucumber']);
  assert.ok(sidecarJson.devDependencies['ts-node']);

  const rootPkgAfter = readFileSync(join(projectRoot, 'package.json'), 'utf8');
  assert.equal(rootPkgBefore, rootPkgAfter);
});

test('ensureRunner for Python creates sidecar venv and installs pytest-bdd', async () => {
  const projectRoot = tmpProject();

  const mockDeps: ProvisionDeps = {
    runCmd: async (cmd, args) => {
      if (cmd === 'uv') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd.includes('pip')) {
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'failed' };
    },
  };

  const result = await ensureRunner(projectRoot, 'pytest-bdd', mockDeps);
  assert.equal(result.status, 'provisioned');
});

test('ensureRunner returns fixable when toolchain is missing or fails', async () => {
  const projectRoot = tmpProject();

  const failingDeps: ProvisionDeps = {
    runCmd: async () => ({ code: 1, stdout: '', stderr: 'Command failed' }),
  };

  const result = await ensureRunner(projectRoot, 'cucumber', failingDeps);
  assert.equal(result.status, 'fixable');
  assert.ok(result.checklist && result.checklist.length > 0);
});
