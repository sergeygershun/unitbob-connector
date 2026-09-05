import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
      // `ruby -v` first (spec 37-2, criterion 4), then the install itself.
      if (cmd === 'ruby') return { code: 0, stdout: 'ruby 3.2.2 (2023-03-30 revision e51014f9c0)', stderr: '' };
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
  // Both gems are asked for conditionally. `eval_gemfile` runs the project's own
  // Gemfile in this same Dsl object, so an unconditional second `gem` line for
  // something the project already names is a duplicate declaration — and bundler
  // refuses to parse one whose requirement differs from the first.
  assert.match(sidecarContent, /gem "cucumber", "~> 9\.0", require: false unless dependencies\.any\?/);
  // Spec 35-1, criterion 2: the World file blocks outgoing HTTP, and it can only
  // do that if webmock resolves. Promising it in the World and hoping the project
  // happens to carry the gem is the same silence this spec removes.
  assert.match(sidecarContent, /gem "webmock", require: false unless dependencies\.any\?/);

  // Verify root Gemfile remains untouched byte-for-byte
  const rootGemfileAfter = readFileSync(join(projectRoot, 'Gemfile'), 'utf8');
  assert.equal(rootGemfileBefore, rootGemfileAfter);
});

// Spec 40, criterion 2. The connector-owned World requires `rspec/expectations`
// and `rspec/mocks` and installs a full mock lifecycle per scenario, but the
// sidecar Gemfile only ever asked for cucumber and webmock. On noahsat-web (Rails
// on minitest, no rspec of its own) the behavioral branch did not build at all —
// `cannot load such file -- rspec/expectations`. Half the product, lost on a
// whole class of projects.
test('ensureRunner for Ruby asks for the rspec gems the connector-owned World requires', async () => {
  const projectRoot = tmpProject();

  const mockDeps: ProvisionDeps = { runCmd: async () => ({ code: 0, stdout: '', stderr: '' }) };

  const result = await ensureRunner(projectRoot, 'cucumber', mockDeps);
  assert.equal(result.status, 'provisioned');

  const sidecarContent = readFileSync(join(projectRoot, '.unitbob', 'behavioral', 'Gemfile'), 'utf8');
  assert.match(sidecarContent, /gem "rspec-expectations", require: false unless dependencies\.any\?/);
  assert.match(sidecarContent, /gem "rspec-mocks", require: false unless dependencies\.any\?/);
});

// The safety condition, which guards the projects that already work: the two
// lines must stay unpinned. See `provisionRuby` for why a pin would break a
// project carrying rspec-rails rather than help it.
//
// Be honest about the reach of this one. The sidecar Gemfile is a fixed string —
// the `unless dependencies.any?` guard is bundler's to evaluate at parse time,
// not the connector's — so the rspec-rails Gemfile below cannot make this test
// red on its own; it is here to say which project the assertion is about. What
// the assertion really catches is a pin, and that is the mistake worth catching.
// Proof that such a project still resolves end to end is a live run, spec 40 task
// 12; the real-bundler test further down takes it as far as parsing.
test('ensureRunner for Ruby leaves the rspec gems unpinned so a project with rspec-rails still resolves', async () => {
  const projectRoot = tmpProject();
  writeFileSync(
    join(projectRoot, 'Gemfile'),
    'source "https://rubygems.org"\ngem "rails", "5.2.0"\ngroup :test do\n  gem "rspec-rails", "~> 6.1"\nend\n',
  );

  const mockDeps: ProvisionDeps = { runCmd: async () => ({ code: 0, stdout: '', stderr: '' }) };

  await ensureRunner(projectRoot, 'cucumber', mockDeps);

  const sidecarContent = readFileSync(join(projectRoot, '.unitbob', 'behavioral', 'Gemfile'), 'utf8');
  for (const gem of ['rspec-expectations', 'rspec-mocks']) {
    const line = sidecarContent.split('\n').find((each) => each.startsWith(`gem "${gem}"`));
    assert.ok(line, `the sidecar Gemfile declares no ${gem}`);
    assert.equal(line, `gem "${gem}", require: false unless dependencies.any? { |d| d.name == "${gem}" }`);
  }
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

// The bug this file could not have caught before: every Ruby test here mocks
// bundler, so nothing ever asked bundler whether the Gemfile we generate is one
// it will accept. A2.Time (Rails 5.0 / Ruby 2.7.8) answered that for us on
// 2026-08-20 — it pins `webmock "~> 3.23"`, our sidecar asked for `webmock
// (>= 0)`, and bundler stopped at the parse:
//
//   You cannot specify the same gem twice with different version requirements.
//   You specified: webmock (~> 3.23) and webmock (>= 0). Bundler cannot continue.
//
// Its behavioral branch could not be generated at all, and `suite-prepare` wrote
// the same conflicting file again on every retry. So this one test spends a real
// bundler, and skips itself where there is none rather than pretending to pass.
test('the sidecar Gemfile parses under a real bundler when the project pins the same gems', async (t) => {
  if (spawnSync('ruby', ['-rbundler', '-e', 'exit 0']).status !== 0) {
    t.skip('no ruby with bundler on this machine');
    return;
  }

  const projectRoot = tmpProject();
  writeFileSync(
    join(projectRoot, 'Gemfile'),
    'source "https://rubygems.org"\n' +
      'gem "rails", "5.2.0"\n' +
      'group :test do\n' +
      '  gem "webmock", "~> 3.23"\n' +
      '  gem "cucumber", "~> 8.0"\n' +
      // Spec 40: the rspec gems go in on the same terms, and this is the project
      // shape that has to keep working. `rspec-rails` pulls rspec-expectations
      // and rspec-mocks in transitively rather than declaring them, so the guard
      // does not fire and our two lines are added next to it — which is only safe
      // while they carry no pin. Parsing is as far as this reaches; the
      // resolution itself is a live run, spec 40 task 12.
      '  gem "rspec-rails", "~> 6.1"\n' +
      'end\n',
  );

  await ensureRunner(projectRoot, 'cucumber', {
    runCmd: async () => ({ code: 0, stdout: '', stderr: '' }),
  });

  // The Dsl rather than `bundle install` or `bundle check`: parsing is the step
  // that used to fail, and it is the only one that needs neither the network nor
  // a single installed gem. A green here is a real green — a Gemfile that is
  // missing, unreadable or malformed exits non-zero exactly as the duplicate did.
  const bundler = spawnSync('ruby', ['-rbundler', '-e', 'Bundler::Dsl.evaluate(ENV["BUNDLE_GEMFILE"], nil, {})'], {
    cwd: projectRoot,
    env: { ...process.env, BUNDLE_GEMFILE: '.unitbob/behavioral/Gemfile' },
    encoding: 'utf8',
  });

  assert.equal(bundler.status, 0, `bundler could not parse the sidecar Gemfile:\n${bundler.stderr}`);
  assert.doesNotMatch(bundler.stderr ?? '', /same gem twice/, 'the duplicate declaration is what this test exists for');
});

// The other half of the same failure. The message is what a vibecoder acts on,
// and until 2026-08-20 it was a constant: the `GemfileError` above was captured
// into `result` and then dropped, so the run reported "Bundler failed to
// provision Cucumber sidecar gem" and nothing else. The cause had to be
// reconstructed afterwards by asking the user to run bundler by hand — for an
// error the connector had already been told.
test('a failed Ruby provision reports what bundler actually said', async () => {
  const projectRoot = tmpProject();
  const gemfileError =
    '[!] There was an error parsing `Gemfile`: You cannot specify the same gem twice ' +
    'with different version requirements.\nYou specified: webmock (~> 3.23) and webmock (>= 0).';

  const result = await ensureRunner(projectRoot, 'cucumber', {
    runCmd: async () => ({ code: 1, stdout: '', stderr: gemfileError }),
  });

  assert.equal(result.status, 'fixable');
  assert.match(result.message ?? '', /same gem twice/);
  assert.match(result.message ?? '', /webmock \(~> 3\.23\)/);
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
function recorder(): ProvisionDeps & { calls: string[]; envs: Record<string, string>[] } {
  const calls: string[] = [];
  // What each command was *given*, not just what it was. Since spec 36 the
  // connector states every variable it sets on purpose, so the variables are
  // part of the command's meaning rather than something inherited.
  const envs: Record<string, string>[] = [];
  return {
    tools: noTools,
    calls,
    envs,
    runCmd: async (command, args, options) => {
      calls.push(`${command} ${args.join(' ')}`);
      envs.push(options.env ?? {});
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

  // Relative: the interpreter is built and then started by whichever place
  // holds this project's dependencies (spec 36, §4.2).
  const venvPython = '.unitbob/runners/.venv/bin/python';
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

// Spec 43, §5.4. Detection accepts `pyproject.toml` and `Pipfile`; this builder
// only ever read `requirements*.txt`, and finding nothing to install counted as
// nothing needing installation. So a sidecar holding pytest and not one line of
// the application was reported as a success, and the failure surfaced much
// later, as a suite that could not import what it was written to guard.
test('a Python project with no requirements file says so instead of reporting an empty environment', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-provision-pyproject-'));
  writeFileSync(join(projectRoot, 'pyproject.toml'), '[project]\nname = "shop"\ndependencies = ["flask"]\n');
  const deps: ProvisionDeps = { tools: noTools, runCmd: async () => ({ code: 0, stdout: '', stderr: '' }) };

  const result = await ensureStructuralRunner(projectRoot, 'pytest', deps);

  assert.equal(result.status, 'provisioned');
  const notes = result.checklist?.join('\n') ?? '';
  assert.match(notes, /packages are not installed/);
  assert.match(notes, /pyproject\.toml/);
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
  // Unconditional, unlike its Cucumber peer, and that difference is the point:
  // bundler replaces a `:development` dependency (how a gemspec carries
  // rspec-rails) with ours instead of refusing it, so this line is what puts the
  // structural runner in `:default`, where no `BUNDLE_WITHOUT` can reach it.
  assert.match(sidecar, /gem "rspec-rails", require: false\n/);
  assert.doesNotMatch(sidecar, /unless dependencies/, 'the rspec sidecar must not inherit the project groups');
  // Bundler resolves the two together, so the application's own gems come with
  // it — the same arrangement the Cucumber sidecar has used since spec 32-1.
  assert.match(deps.calls[0], /^bundle install$/);
  assert.equal(readFileSync(join(projectRoot, 'Gemfile'), 'utf8'), before);
});

// The structural half of the "say what bundler said" change. Same reasoning as
// its behavioral peer: this message is the only place the reason can appear.
test('a failed Ruby structural provision reports what bundler actually said', async () => {
  const projectRoot = tmpProject();
  const deps = {
    ...recorder(),
    runCmd: async () => ({ code: 1, stdout: '', stderr: 'Could not find gem \'rails (= 5.2.0)\' in rubygems repository.' }),
  };

  const result = await ensureStructuralRunner(projectRoot, 'rspec', deps);

  assert.equal(result.status, 'fixable');
  assert.match(result.message ?? '', /Could not find gem/);
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

// The behavioral suite drives the application, so its environment needs the
// application in it — the same requirement as the structural peer, and since
// 2026-08-12 the same code. It used to be built with `--system-site-packages`
// and given nothing but pytest-bdd, so on a machine without the project's
// packages every scenario failed on `No module named flask` in an environment
// Unitbob had just built.
test('the behavioral Python sidecar installs the application, not just the BDD runner', async () => {
  const projectRoot = tmpProject();
  const deps = recorder();

  const result = await ensureRunner(projectRoot, 'pytest-bdd', deps);

  assert.equal(result.status, 'provisioned');
  const venvPython = '.unitbob/behavioral/.venv/bin/python';
  assert.ok(
    deps.calls.includes(`${venvPython} -m pip install -r requirements.txt`),
    `expected the application's own packages to be installed, got:\n${deps.calls.join('\n')}`,
  );
  assert.ok(deps.calls.includes(`${venvPython} -m pip install pytest-bdd`));
  assert.ok(!deps.calls.some((call) => call.includes('system-site-packages')), 'the environment stays hermetic');
});

// Spec 36, task 2.6, measured on `ruby:3.3-slim` 2026-08-17. A sidecar Gemfile
// adds a gem the project's lockfile has never heard of — that is its whole job —
// and under `frozen` or `deployment` bundler refuses exactly that. The project's
// own `.bundle/config` does not reach here (bundler reads app config relative to
// the Gemfile it was given), but the environment does, and a dev or production
// image setting `BUNDLE_DEPLOYMENT=1` is ordinary.
test('the sidecar install turns frozen bundler off for its own Gemfile, and only there', async () => {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, 'Gemfile'), "gem 'rails'\n");
  const deps = recorder();

  await ensureStructuralRunner(projectRoot, 'rspec', deps);
  await ensureRunner(projectRoot, 'cucumber', deps);

  for (const env of deps.envs) {
    if (!env.BUNDLE_GEMFILE) continue;
    assert.match(env.BUNDLE_GEMFILE, /^\.unitbob\//, 'only ever our own Gemfile');
    assert.equal(env.BUNDLE_FROZEN, 'false');
    assert.equal(env.BUNDLE_DEPLOYMENT, 'false');
  }
  // And it is scoped: nothing that is not a sidecar install carries it.
  assert.equal(deps.envs.some((env) => !env.BUNDLE_GEMFILE && env.BUNDLE_FROZEN !== undefined), false);
});

// Spec 37-2, criterion 4. On a2time the behavioral branch came back as "Bundler
// failed to provision Cucumber sidecar gem", and the reason — the host's Ruby is
// older than the cucumber this connector pins — was something the connector
// could have read in one command and instead left the agent to rediscover by
// running `bundle install` by hand. Said before the install, not out of its
// wreckage.
test('a Ruby older than the pinned cucumber is named before bundler is asked', async () => {
  const projectRoot = tmpProject();
  const ran: string[] = [];

  const result = await ensureRunner(projectRoot, 'cucumber', {
    runCmd: async (cmd, args) => {
      ran.push([cmd, ...args].join(' '));
      if (cmd === 'ruby') return { code: 0, stdout: 'ruby 2.6.10p210 (2022-04-12 revision 5b8c0e2b5e) [x86_64-darwin24]', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.status, 'fixable');
  assert.match(result.message ?? '', /needs Ruby 2\.7 or newer/);
  assert.match(result.message ?? '', /2\.6\.10/);
  assert.deepEqual(ran, ['ruby -v'], 'bundler is never asked');
  // The way out is named, and it is the one the sidecar already supports: a
  // project that declares cucumber itself keeps its own pin.
  assert.match((result.checklist ?? []).join('\n'), /declare .?cucumber.? in/i);
});

test('a project that pins cucumber itself is left to its own version', async () => {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, 'Gemfile'), 'source "https://rubygems.org"\ngem "rails"\ngem "cucumber", "~> 3.1"\n');
  const ran: string[] = [];

  const result = await ensureRunner(projectRoot, 'cucumber', {
    runCmd: async (cmd, args) => {
      ran.push([cmd, ...args].join(' '));
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.status, 'provisioned');
  assert.deepEqual(ran, ['bundle install'], 'our pin does not apply, so neither does its Ruby floor');
});

test('a Ruby that cannot be read stops nothing', async () => {
  const projectRoot = tmpProject();

  const result = await ensureRunner(projectRoot, 'cucumber', {
    runCmd: async (cmd) => (cmd === 'ruby'
      ? { code: 127, stdout: '', stderr: 'command not found' }
      : { code: 0, stdout: '', stderr: '' }),
  });

  assert.equal(result.status, 'provisioned');
});

test('a Ruby new enough is not mentioned at all', async () => {
  const projectRoot = tmpProject();

  const result = await ensureRunner(projectRoot, 'cucumber', {
    runCmd: async (cmd) => (cmd === 'ruby'
      ? { code: 0, stdout: 'ruby 3.2.2 (2023-03-30 revision e51014f9c0) [arm64-darwin23]', stderr: '' }
      : { code: 0, stdout: '', stderr: '' }),
  });

  assert.equal(result.status, 'provisioned');
});

// The Gemfile is read as text; the line that drops our pin asks bundler's own
// resolved dependency list. Where the two can disagree — `gemspec`,
// `eval_gemfile` — the check stays quiet rather than refusing a build that
// works over a floor it never had to meet.
test('a gemspec or an eval_gemfile keeps the Ruby floor out of it', async () => {
  for (const line of ['gemspec\n', 'eval_gemfile "shared/Gemfile"\n']) {
    const projectRoot = tmpProject();
    writeFileSync(join(projectRoot, 'Gemfile'), `source "https://rubygems.org"\n${line}`);
    const ran: string[] = [];

    const result = await ensureRunner(projectRoot, 'cucumber', {
      runCmd: async (cmd, args) => {
        ran.push([cmd, ...args].join(' '));
        if (cmd === 'ruby') return { code: 0, stdout: 'ruby 2.6.10p210', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    assert.equal(result.status, 'provisioned', line);
    assert.deepEqual(ran, ['bundle install'], line);
  }
});

test('a commented-out cucumber line is not a declaration', async () => {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, 'Gemfile'), 'source "https://rubygems.org"\n# gem "cucumber", "~> 3.1"\n');

  const result = await ensureRunner(projectRoot, 'cucumber', {
    runCmd: async (cmd) => (cmd === 'ruby'
      ? { code: 0, stdout: 'ruby 2.6.10p210', stderr: '' }
      : { code: 0, stdout: '', stderr: '' }),
  });

  assert.equal(result.status, 'fixable');
});
