import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRunner, ensureStructuralRunner, type ProvisionDeps } from '../src/runner/provision.ts';
import type { ToolDeps } from '../src/runner/toolchain.ts';

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

// --- Structural runners (the peer of the BDD provisioning above) -------------
//
// A vibecoder who has never installed a test runner is the ordinary customer.
// These tests pin the two halves of the promise that follows from that: the
// runner and the application's dependencies are installed under `.unitbob/`,
// and the project itself is read and never written.

const noTools: ToolDeps = { commandSucceeds: () => false };
const everythingInstalled: ToolDeps = { commandSucceeds: () => true };

// Records what was asked to run, and answers everything with success.
function recorder(): ProvisionDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    tools: noTools,
    calls,
    runCmd: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

test('ensureStructuralRunner leaves a project that already has its runner completely alone', async () => {
  const projectRoot = tmpProject();
  const deps = { ...recorder(), tools: everythingInstalled };

  const result = await ensureStructuralRunner(projectRoot, 'pytest', deps);

  assert.equal(result.status, 'provisioned');
  assert.deepEqual(deps.calls, [], 'nothing should be installed for a project that is already set up');
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'runners')), false);
});

test('ensureStructuralRunner installs the application\'s packages and pytest into .unitbob', async () => {
  const projectRoot = tmpProject();
  const deps = recorder();

  const result = await ensureStructuralRunner(projectRoot, 'pytest', deps);
  assert.equal(result.status, 'provisioned');

  const venvPython = join(projectRoot, '.unitbob', 'runners', '.venv', 'bin', 'python');
  // The standard-library builder before uv: it is the one that puts pip in the
  // environment, and an environment with no pip cannot be installed into.
  // No `--system-site-packages`: the environment holds the requirements file
  // and pytest, and nothing the machine happens to have lying around.
  assert.match(deps.calls[0], /^python3 -m venv .*\.unitbob\/runners\/\.venv$/);
  assert.doesNotMatch(deps.calls[0], /system-site-packages/);
  // The application's own requirements come first, so a failure there is
  // reported against the requirements file rather than against pytest.
  assert.equal(deps.calls[1], `${venvPython} -m pip install -r requirements.txt`);
  assert.equal(deps.calls[2], `${venvPython} -m pip install pytest`);
});

test('a requirements file that will not install is a note, not a refusal', async () => {
  const projectRoot = tmpProject();
  const deps: ProvisionDeps = {
    tools: noTools,
    runCmd: async (_command, args) => ({
      code: args.includes('-r') ? 1 : 0,
      stdout: 'Building wheel for psycopg2-binary\nnote: This error originates from a subprocess',
      stderr:
        "error: Command '['clang', '-fno-strict-overflow', '-Wsign-compare', '-Wunreachable-code', " +
        "'-fno-common', '-dynamic', '-DNDEBUG', '-g', '-O3', '-Wall', '-I/opt/homebrew/include']' returned 1\n" +
        'ERROR: Failed building wheel for psycopg2-binary',
    }),
  };

  // pytest still installed, so the suite can be built and run. What it cannot
  // do is import the application.
  const result = await ensureStructuralRunner(projectRoot, 'pytest', deps);
  assert.equal(result.status, 'provisioned');

  const notes = result.checklist?.join('\n') ?? '';
  assert.match(notes, /requirements\.txt.*did not finish/);
  // With the installer's own reason, so nobody has to re-run the install by
  // hand to find out what it objected to. Found doing exactly that on a Flask
  // project whose pinned psycopg2 has no wheel for Python 3.14, 2026-08-12.
  assert.match(notes, /Failed building wheel for psycopg2-binary/);
  // Among the lines that look like errors, one is a verbatim dump of the
  // compiler command — three hundred characters whose only readable part is the
  // word "clang". Reporting it would be worse than reporting nothing.
  assert.doesNotMatch(notes, /fno-strict-overflow/, 'a command dump is not the reason');
});

test('no way to create a virtualenv is fixable, with the command that fixes it', async () => {
  const deps: ProvisionDeps = { tools: noTools, runCmd: async () => ({ code: 1, stdout: '', stderr: '' }) };

  const result = await ensureStructuralRunner(tmpProject(), 'pytest', deps);

  assert.equal(result.status, 'fixable');
  assert.match(result.message ?? '', /Failed to create a virtual environment/);
  assert.match(result.checklist?.join('\n') ?? '', /python3 -m venv|pip install uv/);
});

test('ensureStructuralRunner for Ruby adds rspec-rails beside the project Gemfile, not in it', async () => {
  const projectRoot = tmpProject();
  const before = readFileSync(join(projectRoot, 'Gemfile'), 'utf8');
  const deps = recorder();

  const result = await ensureStructuralRunner(projectRoot, 'rspec', deps);
  assert.equal(result.status, 'provisioned');

  const sidecar = readFileSync(join(projectRoot, '.unitbob', 'runners', 'Gemfile'), 'utf8');
  assert.match(sidecar, /eval_gemfile/);
  assert.match(sidecar, /gem "rspec-rails"/);
  // Bundler resolves the two together, so the application's own gems come with
  // it — the same arrangement the Cucumber sidecar has used since spec 32-1.
  assert.match(deps.calls[0], /^bundle install$/);
  assert.equal(readFileSync(join(projectRoot, 'Gemfile'), 'utf8'), before);
});

test('ensureStructuralRunner for JS installs vitest and says what it cannot install', async () => {
  const projectRoot = tmpProject();
  const deps = recorder();

  const result = await ensureStructuralRunner(projectRoot, 'vitest', deps);

  assert.equal(result.status, 'provisioned');
  assert.match(readFileSync(join(projectRoot, '.unitbob', 'runners', 'package.json'), 'utf8'), /"vitest"/);
  assert.match(deps.calls[0], /^npm install --prefix \.unitbob\/runners$/);
  // Node resolves an import by walking up from the importing file, so a suite in
  // `.unitbob/structural/` can only ever find the project's own node_modules.
  // Saying so is the honest answer; quietly installing a copy nobody will load
  // would not be.
  assert.match(result.checklist?.join('\n') ?? '', /node_modules.*missing|Run `npm install` in the project/s);
});

// A virtualenv built by `uv venv` has no pip in it at all. Calling `bin/pip`
// there throws ENOENT, which reads as "the install failed" when nothing was
// ever attempted — and the environment was then reported as ready, because a
// `bin/python` was sitting in it. Found on a Flask project, 2026-08-12.
test('installing into the sidecar falls back to uv pip when the environment has no pip', async () => {
  const projectRoot = tmpProject();
  const calls: string[] = [];
  const deps: ProvisionDeps = {
    tools: noTools,
    runCmd: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      // Everything works except `python -m pip`, exactly as a uv-built
      // environment behaves.
      return { code: args[0] === '-m' && args[1] === 'pip' ? 1 : 0, stdout: '', stderr: '' };
    },
  };

  const result = await ensureStructuralRunner(projectRoot, 'pytest', deps);

  assert.equal(result.status, 'provisioned');
  assert.ok(
    calls.some((call) => /^uv pip install --python .*bin\/python pytest$/.test(call)),
    `expected a uv pip fallback, got:\n${calls.join('\n')}`,
  );
});

// An interpreter that is merely present is not one the project can run on. A
// machine can carry a Python newer than everything the project pins — measured
// on a Flask app whose psycopg2, greenlet and multidict have no wheels for 3.14
// and do not compile against it, while the 3.11 beside it installs all three in
// seconds. Found 2026-08-12.
test('an environment the project\'s packages will not install into is rebuilt with the next Python', async () => {
  const projectRoot = tmpProject();
  const calls: string[] = [];
  const deps: ProvisionDeps = {
    tools: noTools,
    runCmd: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      // requirements.txt installs under the second interpreter only, exactly as
      // a project pinned below the machine's newest Python behaves.
      const isRequirements = args.includes('-r');
      const builtByFirst = calls.some((call) => call.startsWith('python3 -m venv'))
        && !calls.some((call) => call.startsWith('python -m venv'));
      return { code: isRequirements && builtByFirst ? 1 : 0, stdout: '', stderr: 'error: no wheel' };
    },
  };

  const result = await ensureStructuralRunner(projectRoot, 'pytest', deps);

  assert.equal(result.status, 'provisioned');
  assert.ok(calls.some((call) => call.startsWith('python -m venv')), `expected a second builder, got:\n${calls.join('\n')}`);
  // And it says nothing about a failure, because in the end there was none.
  assert.equal(result.checklist, undefined);
});

test('when no Python here can take the requirements, the last environment is kept', async () => {
  const projectRoot = tmpProject();
  const deps: ProvisionDeps = {
    tools: noTools,
    runCmd: async (_command, args) => ({
      code: args.includes('-r') ? 1 : 0,
      stdout: '',
      stderr: 'ERROR: Failed building wheel for psycopg2-binary',
    }),
  };

  // pytest still installs into it, and a suite that runs and cannot import the
  // application says far more than no suite at all.
  const result = await ensureStructuralRunner(projectRoot, 'pytest', deps);
  assert.equal(result.status, 'provisioned');
  assert.match(result.checklist?.join('\n') ?? '', /did not finish on any Python available here/);
  assert.match(result.checklist?.join('\n') ?? '', /psycopg2-binary/);
});
