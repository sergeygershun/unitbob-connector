import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  locateRunner,
  projectProvidesRunner,
  SIDECAR_DIR,
  type ToolDeps,
} from '../src/runner/toolchain.ts';

// One place decides how a structural runner is started, so the precheck, the
// boot check and the run can never end up talking about different
// installations. These tests pin that resolution — above all the order, which
// is what keeps two runs of the same suite on the same environment.

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-toolchain-'));
}

const pytestPresent: ToolDeps = { commandSucceeds: () => true };
const pytestMissing: ToolDeps = { commandSucceeds: () => false };

// Creates the file on the host and hands back the name a *command* carries:
// relative to the project root, because that is the one form that means the same
// thing wherever the run happens (spec 36, §4.2).
function withExecutable(projectRoot: string, ...segments: string[]): string {
  const path = join(projectRoot, ...segments);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '', { mode: 0o755 });
  return segments.join('/');
}

test('pytest: a sidecar interpreter is preferred over the machine\'s own', () => {
  const projectRoot = tmpProject();
  const venvPython = withExecutable(projectRoot, SIDECAR_DIR, '.venv', 'bin', 'python');

  // Even with a perfectly good system pytest, the sidecar wins: it is the
  // environment the build was prepared against, and a run that silently moves
  // between interpreters cannot mean "green means fine".
  assert.deepEqual(locateRunner(projectRoot, 'pytest', pytestPresent), {
    command: venvPython,
    args: ['-m', 'pytest'],
    source: 'sidecar',
  });
});

test('pytest: falls back to the interpreter that can import pytest', () => {
  assert.deepEqual(locateRunner(tmpProject(), 'pytest', pytestPresent), {
    command: 'python3',
    args: ['-m', 'pytest'],
    source: 'project',
  });
});

test('pytest: nothing to run with is null, not a guess', () => {
  assert.equal(locateRunner(tmpProject(), 'pytest', pytestMissing), null);
});

test('vitest: sidecar first, then the project, never npx', () => {
  const both = tmpProject();
  withExecutable(both, 'node_modules', '.bin', 'vitest');
  const sidecarBin = withExecutable(both, SIDECAR_DIR, 'node_modules', '.bin', 'vitest');
  assert.equal(locateRunner(both, 'vitest')?.command, sidecarBin);
  assert.equal(locateRunner(both, 'vitest')?.source, 'sidecar');

  const projectOnly = tmpProject();
  const projectBin = withExecutable(projectOnly, 'node_modules', '.bin', 'vitest');
  assert.equal(locateRunner(projectOnly, 'vitest')?.command, projectBin);
  assert.equal(locateRunner(projectOnly, 'vitest')?.source, 'project');

  // `npx` would install a package to answer a question. The vitest runner keeps
  // it as its own last resort; this lookup, which checks also call, does not.
  assert.equal(locateRunner(tmpProject(), 'vitest'), null);
});

test('rspec: a sidecar Gemfile is selected by BUNDLE_GEMFILE, not by a different binary', () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, SIDECAR_DIR), { recursive: true });
  writeFileSync(join(projectRoot, SIDECAR_DIR, 'Gemfile'), 'eval_gemfile "../../Gemfile"\n');

  assert.deepEqual(locateRunner(projectRoot, 'rspec'), {
    command: 'bundle',
    args: ['exec', 'rspec'],
    env: { BUNDLE_GEMFILE: `${SIDECAR_DIR}/Gemfile` },
    source: 'sidecar',
  });
});

test('rspec: the project\'s own binstub is preferred to bundle exec', () => {
  const projectRoot = tmpProject();
  const binstub = withExecutable(projectRoot, 'bin', 'rspec');

  assert.deepEqual(locateRunner(projectRoot, 'rspec'), { command: binstub, args: [], source: 'project' });
});

test('rspec: with neither, bundle exec rspec is the answer — never null', () => {
  assert.deepEqual(locateRunner(tmpProject(), 'rspec'), {
    command: 'bundle',
    args: ['exec', 'rspec'],
    source: 'project',
  });
});

test('an unknown runner resolves to nothing', () => {
  assert.equal(locateRunner(tmpProject(), 'jest'), null);
});

// What provisioning asks before it builds anything. A developer with a working
// setup must not find a second copy of their toolchain under .unitbob/.
test('projectProvidesRunner: Ruby answers from the Gemfile, not from bundle exec', () => {
  const bare = tmpProject();
  writeFileSync(join(bare, 'Gemfile'), "gem 'rails'\n");
  // `locateRspec` always has a `bundle exec rspec` to offer, so asking it would
  // answer "yes" for every Rails project on earth. The gem has to be there.
  assert.equal(projectProvidesRunner(bare, 'rspec'), false);

  const ready = tmpProject();
  writeFileSync(join(ready, 'Gemfile'), "gem 'rails'\ngem 'rspec-rails'\n");
  assert.equal(projectProvidesRunner(ready, 'rspec'), true);
});

test('projectProvidesRunner: a sidecar is not the project providing anything', () => {
  const projectRoot = tmpProject();
  withExecutable(projectRoot, SIDECAR_DIR, '.venv', 'bin', 'python');

  // Otherwise the second run would decide the first run's sidecar counts as the
  // project being set up, and stop keeping it current.
  assert.equal(projectProvidesRunner(projectRoot, 'pytest', pytestMissing), false);
  assert.equal(projectProvidesRunner(tmpProject(), 'pytest', pytestPresent), true);
});
