import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootCheck as askBootCheck, testDatabaseIsSeparate, type BootCheckDeps } from '../src/runner/bootcheck.ts';
import { UNITBOB_HELPER_RB } from '../src/files/guardrails.ts';
import { VITEST_BOOT_CONFIG_FILE } from '../src/runner/vitest.ts';

// Spec 32-6 Phase 1. The question this module answers is narrow on purpose:
// not "is the app healthy" but "would the suite get off the ground". These
// tests hold it to that line — in particular they pin the cases where the
// honest answer is "we did not check", because treating those as "broken"
// would block projects that are perfectly fine.

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-bootcheck-'));
}

// Spec 38. The check is asked about a list of the project's own source files —
// the ones this branch's guardrails will import — and never about the project's
// tests. Every test below that is not about the list itself passes the same
// one-file list, so the subject stays whatever it was already about.
//
// Ruby ignores the list entirely: its helper is the suite's real first line.
const SOURCES = ['app/billing.rb'];
const bootCheck = (
  projectRoot: string,
  runner: string | null,
  deps: BootCheckDeps,
  sourceFiles: string[] = SOURCES,
) => askBootCheck(projectRoot, runner, sourceFiles, deps);

function railsProject(): string {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'structural'), { recursive: true });
  writeFileSync(join(projectRoot, '.unitbob', 'structural', 'unitbob_helper.rb'), UNITBOB_HELPER_RB);
  return projectRoot;
}

// An installed vitest, executable as npm leaves it — the check now asks for the
// bit rather than for the file, so the fixture has to be honest about it.
function vitestProject(mode = 0o755): string {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(projectRoot, 'node_modules', '.bin', 'vitest'), '', { mode });
  return projectRoot;
}

// One canned process result, and a record of what was asked to run.
function fakeRunner(
  results: { code: number | null; stdout?: string; stderr?: string }[],
): BootCheckDeps & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    runCmd: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      const next = results[Math.min(index, results.length - 1)];
      index += 1;
      return { code: next.code, stdout: next.stdout ?? '', stderr: next.stderr ?? '' };
    },
  };
}

test('rspec: the helper loads cleanly, so the suite can start', async () => {
  const deps = fakeRunner([{ code: 0 }]);
  const result = await bootCheck(railsProject(), 'rspec', deps);

  assert.deepEqual(result, { status: 'ok' });
  // It loads the very file the generated spec requires first — not a stand-in.
  assert.match(deps.calls[0], /exec ruby -e require .*unitbob_helper\.rb/);
});

// ADR 1: a check that predicts an operation may be looser than it, never
// stricter. This one predicts the RSpec run and reaches the same file through a
// different door — the run through the `rspec` binary, the check through a bare
// interpreter — so whatever that binary would have loaded first, the file has to
// load for itself. rspec-core is the whole of that difference, and on the a2time
// run of 2026-08-04 it was enough to call a healthy project broken.
test('rspec: the check needs nothing the run would have set up for it', async () => {
  const deps = fakeRunner([{ code: 0 }]);
  await bootCheck(railsProject(), 'rspec', deps);

  // Loaded by a bare interpreter, not by the runner…
  assert.match(deps.calls[0], /ruby -e/);
  assert.ok(!/\brspec\b/.test(deps.calls[0]), 'the check does not go through the rspec binary');
  // …so the file it loads carries what that binary would have brought with it.
  assert.match(UNITBOB_HELPER_RB, /require 'rspec\/core'/);
  assert.ok(
    UNITBOB_HELPER_RB.indexOf("require 'rspec/core'") < UNITBOB_HELPER_RB.indexOf("require 'rails_helper'"),
    'rspec-core must be required before the project setup that uses it',
  );
});

test('rspec: a failed load is broken, and quotes the runner word for word', async () => {
  const stderr =
    "/app/models/report.rb:1:in `<main>': undefined method `before_validation' for main:Object (NoMethodError)";
  const result = await bootCheck(railsProject(), 'rspec', fakeRunner([{ code: 1, stderr }]));

  assert.equal(result.status, 'broken');
  if (result.status !== 'broken') return;
  // Verbatim, including the file and line the runner chose to print. A
  // paraphrase would be a string the vibecoder cannot search for.
  assert.equal(result.message, stderr);
  assert.match(result.detail, /report\.rb/);
});

// Which bundler gets to answer. `runRspecSuite` already picks "the project's
// own binstub, else the global tool" and already tests the binstub for its
// executable bit; this check has to make the same choice the same way, or it
// stops predicting the run it exists to predict.
test("rspec: the project's own bundler binstub is preferred", async () => {
  const projectRoot = railsProject();
  mkdirSync(join(projectRoot, 'bin'), { recursive: true });
  writeFileSync(join(projectRoot, 'bin', 'bundle'), '#!/bin/sh\n', { mode: 0o755 });

  const deps = fakeRunner([{ code: 0 }]);
  await bootCheck(projectRoot, 'rspec', deps);

  assert.match(deps.calls[0], /bin\/bundle exec ruby/);
});

// A binstub that is there but cannot be run — a checkout over a filesystem
// without permission bits, an archive unpacked without them. `spawn` answers
// EACCES by throwing, which came back as `no_runner`: "no runner available to
// load your suite with", told to someone whose bundler works fine and is on
// their PATH. The same mistake `runner_too_old` and `runner_could_not_answer`
// were added to stop making, one directory over.
test('rspec: a binstub that cannot be executed falls back to the global bundler', async () => {
  const projectRoot = railsProject();
  mkdirSync(join(projectRoot, 'bin'), { recursive: true });
  writeFileSync(join(projectRoot, 'bin', 'bundle'), '#!/bin/sh\n', { mode: 0o644 });

  const deps = fakeRunner([{ code: 0 }]);
  const result = await bootCheck(projectRoot, 'rspec', deps);

  assert.deepEqual(result, { status: 'ok' });
  assert.match(deps.calls[0], /^bundle exec ruby/);
});

test('a project frame plus a real error reads as a defect in the code', async () => {
  const stderr = "/app/models/report.rb:1:in `<main>': undefined method `before_validation' (NoMethodError)";
  const result = await bootCheck(railsProject(), 'rspec', fakeRunner([{ code: 1, stderr }]));

  assert.equal(result.status === 'broken' && result.cause, 'defect_in_code');
});

test('a missing gem reads as environment, not as a defect', async () => {
  const stderr = 'bundler: failed to load command: rspec\nBundler::GemNotFound: Could not find rake-13.0.6';
  const result = await bootCheck(railsProject(), 'rspec', fakeRunner([{ code: 1, stderr }]));

  assert.equal(result.status === 'broken' && result.cause, 'environment_not_ready');
});

// The half a Rails-shaped reading misses, and the pair of tests that actually
// proves both halves are load-bearing.
//
// The first version of this test used a project whose files did not exist, so
// "is there a frame in the project's own code" answered no for the wrong
// reason and the dependency rule alone decided the outcome. It passed with the
// second condition deleted — it guarded nothing, which is why it did not catch
// the Python misclassification the sibling test below now pins.
//
// Here the frame is a file that really is in the project. Ruby resolves gems
// through `bundler/setup` before the first application file, so a missing gem
// there never has a project frame; Python and JS resolve the import from inside
// one, so "project frame means defect" on its own would call an un-run
// `pip install` a bug in the user's code.
function pythonProject(): string {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'mypackage'), { recursive: true });
  writeFileSync(join(projectRoot, 'mypackage', 'billing.py'), 'x = 1\n');
  return projectRoot;
}

test('a missing module inside a real project file is still environment, not a defect', async () => {
  const stdout = [
    'mypackage/billing.py:3: in <module>',
    '    import requests',
    "E   ModuleNotFoundError: No module named 'requests'",
  ].join('\n');
  const result = await bootCheck(pythonProject(), 'pytest', fakeRunner([{ code: 2, stdout }]));

  // The frame *is* in the project's own code, so only the dependency rule can
  // produce this answer. Delete that rule and this test fails.
  assert.equal(result.status === 'broken' && result.cause, 'environment_not_ready');
});

// The other direction, and the one the first draft got wrong: the same project
// frame, an error that is not a missing dependency. pytest prints frames
// relative to the working directory, so neither the Rails directory names nor
// an absolute-path match sees this — the file has to be recognised by existing.
test('a real defect in the project\'s own Python file is a defect, not environment', async () => {
  const stdout = [
    'mypackage/billing.py:12: in <module>',
    'E   NameError: name "Decimal" is not defined',
  ].join('\n');
  const result = await bootCheck(pythonProject(), 'pytest', fakeRunner([{ code: 2, stdout }]));

  assert.equal(result.status === 'broken' && result.cause, 'defect_in_code');
});

// A frame that names a file this project does not have is not this project's
// code, however plausible the path looks.
test('a frame in an installed dependency is not the project\'s own code', async () => {
  const stdout = [
    '.venv/lib/python3.12/site-packages/requests/api.py:59: in request',
    'E   TypeError: unhashable type',
  ].join('\n');
  const result = await bootCheck(pythonProject(), 'pytest', fakeRunner([{ code: 2, stdout }]));

  assert.equal(result.status === 'broken' && result.cause, 'environment_not_ready');
});

test('pytest: the probe imports cleanly, so the suite can start', async () => {
  const deps = fakeRunner([{ code: 0 }]);
  const result = await bootCheck(tmpProject(), 'pytest', deps);

  assert.deepEqual(result, { status: 'ok' });
  // `-c` with an empty-addopts config, exactly as the real pytest runner does.
  // Without it the project's own `addopts` decide the answer, and a project
  // asking for a plugin it has not installed was refused as `broken`.
  assert.match(deps.calls[0], /-m pytest -c \.unitbob\/pytest\.ini/);
  // Spec 38, criterion 1. One path, and it is ours. `.unitbob` is hidden, which
  // pytest's default norecursedirs skips, so naming it explicitly is the only
  // way our probe is the thing collected.
  assert.match(deps.calls[0], /\.unitbob\/structural\/test_unitbob_boot\.py/);
  assert.ok(!deps.calls[0].includes('--collect-only'), 'the probe is run, not merely collected');
});

// The heart of criterion 1 on this stack: the project's own test tree is never
// named, so nothing in it can be opened, and nothing in it can be blamed.
test('pytest: nothing of the project\'s own test tree is passed to the runner', async () => {
  const deps = fakeRunner([{ code: 0 }]);
  await bootCheck(tmpProject(), 'pytest', deps);

  const paths = deps.calls[0].split(' ').filter((word) => word.endsWith('.py'));
  assert.deepEqual(paths, ['.unitbob/structural/test_unitbob_boot.py']);
});

// The probe names the files it was given, and is gone by the time anything else
// looks in that directory — one left behind would be collected by the project's
// own next test run, which is not ours to change.
test('pytest: the probe carries the named sources and does not outlive the check', async () => {
  const projectRoot = tmpProject();
  const probeFile = join(projectRoot, '.unitbob/structural/test_unitbob_boot.py');
  let probe = '';

  await bootCheck(projectRoot, 'pytest', {
    runCmd: async () => {
      probe = readFileSync(probeFile, 'utf8');
      return { code: 0, stdout: '', stderr: '' };
    },
  }, ['app/services/billing.py']);

  assert.match(probe, /"app\/services\/billing\.py"/);
  assert.equal(existsSync(probeFile), false);
});

// Spec 50. The probe imports modules by name, the way the guardrails will,
// rather than executing files by path: a file already imported through a
// neighbour (`app/models.py` behind `from app import db`) is taken from
// `sys.modules` instead of being run a second time, and `app/__init__.py` is
// the package `app`, not a module called `app.__init__`.
test('pytest: the probe imports the named modules the way the run imports them', async () => {
  const projectRoot = tmpProject();
  const probeFile = join(projectRoot, '.unitbob/structural/test_unitbob_boot.py');
  let probe = '';

  await bootCheck(projectRoot, 'pytest', {
    runCmd: async () => {
      probe = readFileSync(probeFile, 'utf8');
      return { code: 0, stdout: '', stderr: '' };
    },
  }, ['app/__init__.py', 'app/models.py']);

  assert.match(probe, /importlib\.import_module\(name\)/);
  assert.doesNotMatch(probe, /spec_from_file_location|exec_module|module_from_spec/);
  // `app/__init__.py` is `app`: the `.__init__` tail is dropped before the import.
  assert.match(probe, /"\.__init__"/);
  assert.match(probe, /sys\.path\.insert\(0, str\(ROOT\)\)/);
});

// Spec 50, criterion 4, with a real interpreter. The shape of microblog on the
// bench, 2026-09-11: a package whose `__init__` imports its models, and models
// that refuse to be declared twice — SQLAlchemy's "Table 'followers' is already
// defined". Executing the file by path ran it a second time and the branch was
// refused; importing it by name finds it already loaded. Skipped where no
// pytest answers, as the graphify test in `proc.test.ts` is.
async function pytestOnThisMachine(): Promise<boolean> {
  const { runProcess } = await import('../src/proc.ts');
  try {
    const result = await runProcess('python3', ['-m', 'pytest', '--version'], { cwd: tmpdir(), timeoutMs: 30_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

function pythonPackageProject(): string {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'app'), { recursive: true });
  writeFileSync(join(projectRoot, 'app', 'registry.py'), 'TABLES = set()\n');
  writeFileSync(
    join(projectRoot, 'app', 'models.py'),
    'from app.registry import TABLES\n' +
      'if "followers" in TABLES:\n' +
      '    raise RuntimeError("Table \'followers\' is already defined for this MetaData instance")\n' +
      'TABLES.add("followers")\n',
  );
  writeFileSync(join(projectRoot, 'app', '__init__.py'), 'from . import models\n');
  return projectRoot;
}

test('pytest: a module already imported through its package is not executed twice', async (t) => {
  if (!(await pytestOnThisMachine())) {
    t.skip('python3 -m pytest does not answer on this machine');
    return;
  }
  const { runInProject } = await import('../src/runner/place.ts');
  const real: BootCheckDeps = {
    runCmd: (command, args, options) => runInProject(options.cwd, command, args, { timeoutMs: 60_000, env: options.env }),
  };

  const projectRoot = pythonPackageProject();
  assert.deepEqual(await bootCheck(projectRoot, 'pytest', real, ['app/__init__.py', 'app/models.py']), { status: 'ok' });

  // Criterion 3: red stays red. A module whose import needs a package nobody
  // has is still the environment, with the same cause as before.
  writeFileSync(join(projectRoot, 'app', 'billing.py'), 'import a_package_nobody_has\n');
  const broken = await bootCheck(projectRoot, 'pytest', real, ['app/__init__.py', 'app/models.py', 'app/billing.py']);
  assert.equal(broken.status, 'broken');
  assert.equal((broken as { cause: string }).cause, 'environment_not_ready');
  assert.match((broken as { detail: string }).detail, /app\/billing\.py:1/);
});

// Nothing resolved to a file, so there is nothing to import. A hole in the graph
// is not a broken application, and the runner is not started to find that out.
test('pytest: an empty list of sources is nothing to load, and starts nothing', async () => {
  const deps = fakeRunner([{ code: 0 }]);

  assert.deepEqual(await bootCheck(tmpProject(), 'pytest', deps, []), {
    status: 'not_checked',
    reason: 'nothing_to_load',
  });
  assert.deepEqual(deps.calls, []);
});

// pytest's own exit vocabulary. Only "your code did not load" is an answer about
// the project; a bad invocation or an internal error says nothing about it and
// must never read as "your suite cannot start".
//
// The reason is `runner_could_not_answer`, never `no_runner`: pytest is
// installed and was reached, it only declined the question. Telling someone
// their runner is missing sends them to fix a thing that works — the same
// mistake `runner_too_old` was added to stop making about vitest.
test('pytest: a usage or internal error is not checked, not broken', async () => {
  for (const code of [3, 4]) {
    assert.deepEqual(await bootCheck(tmpProject(), 'pytest', fakeRunner([{ code, stdout: 'ERROR: usage' }])), {
      status: 'not_checked',
      reason: 'runner_could_not_answer',
    }, `exit ${code}`);
  }
});

// Ruby's own standard library sits under `…/lib/ruby/`, which the `lib/` rule
// for business code would otherwise claim as this project's own.
test('a frame in the language\'s own standard library is not the project\'s code', async () => {
  const stderr = [
    "/opt/homebrew/lib/ruby/3.3.0/psych.rb:456:in `parse': (<unknown>): could not find expected ':'",
    "\tfrom /opt/homebrew/lib/ruby/3.3.0/psych.rb:324:in `load'",
  ].join('\n');
  const result = await bootCheck(railsProject(), 'rspec', fakeRunner([{ code: 1, stderr }]));

  assert.equal(result.status === 'broken' && result.cause, 'environment_not_ready');
});

test('pytest: an import error in collected code is broken', async () => {
  const stdout = 'app/billing.py:2: in <module>\nE   SyntaxError: invalid syntax';
  const result = await bootCheck(tmpProject(), 'pytest', fakeRunner([{ code: 2, stdout }]));

  assert.equal(result.status, 'broken');
});

// pytest exits 5 when it collected nothing. Since spec 38 the only file offered
// for collection is our own probe, so this means our probe was not collected —
// still nothing about the project's code, and still not `broken`.
test('pytest: nothing collected is not checked, not broken', async () => {
  const result = await bootCheck(tmpProject(), 'pytest', fakeRunner([{ code: 5, stdout: 'no tests ran' }]));

  assert.deepEqual(result, { status: 'not_checked', reason: 'nothing_to_load' });
});

// --- Spec 38: our runner, our file, never their tests --------------------

// The test this whole spec came from. It used to assert that the command was
// exactly `vitest list`, and in doing so it pinned the bug: `list` collects the
// project's *entire* test tree, so a jest project — 189 green tests of its own —
// came back "found a defect that stops your test suite from starting" because
// vitest does not define `describe` the way jest does. A green unit test held
// that in place for weeks. The assertion is now the opposite one: the command
// must carry a limit, and the limit must be ours.
test('vitest: the check runs our own probe under a config we wrote', async () => {
  const deps = fakeRunner([{ code: 0 }]);
  const result = await bootCheck(vitestProject(), 'vitest', deps);

  assert.deepEqual(result, { status: 'ok' });
  assert.equal(deps.calls.length, 1, 'one command, no version probe in front of it');
  assert.match(deps.calls[0], new RegExp(`vitest run --config ${VITEST_BOOT_CONFIG_FILE.replace('.', '\\.')}$`));
  // Not `list`, and no bare `run` either: a run without the config would collect
  // whatever the project's own include covers.
  assert.ok(!/\blist\b/.test(deps.calls[0]));
});

// Said as its own property, because it is the criterion rather than a detail of
// the command: no path into the project's test tree, and nothing that could
// widen the collection back out to it.
test('vitest: no test file of the project\'s own can reach the runner', async () => {
  const projectRoot = vitestProject();
  const deps = fakeRunner([{ code: 0 }]);
  await bootCheck(projectRoot, 'vitest', deps);

  // Every argument is either the subcommand or our own config.
  const args = deps.calls[0].split(' ').slice(1);
  assert.deepEqual(args, ['run', '--config', VITEST_BOOT_CONFIG_FILE]);
});

// Both connector-owned files, read at the moment the runner was invoked, since
// neither survives the call.
async function bootFiles(projectRoot: string, sourceFiles?: string[]): Promise<{ probe: string; config: string }> {
  const probeFile = join(projectRoot, '.unitbob/structural/__unitbob_boot.test.mjs');
  const files = { probe: '', config: '' };

  await bootCheck(projectRoot, 'vitest', {
    runCmd: async () => {
      files.probe = readFileSync(probeFile, 'utf8');
      files.config = readFileSync(join(projectRoot, VITEST_BOOT_CONFIG_FILE), 'utf8');
      return { code: 0, stdout: '', stderr: '' };
    },
  }, sourceFiles);

  assert.equal(existsSync(probeFile), false, 'the probe does not outlive the check');
  assert.equal(
    existsSync(join(projectRoot, VITEST_BOOT_CONFIG_FILE)),
    false,
    'nor does the config that named it',
  );
  return files;
}

test('vitest: the probe imports the named sources and is removed afterwards', async () => {
  const { probe, config } = await bootFiles(vitestProject(), [
    'src/services/billing.ts',
    'src/controllers/auth.ts',
  ]);

  // Two levels up from `.unitbob/structural/`, one import per named file.
  assert.match(probe, /^import "\.\.\/\.\.\/src\/services\/billing\.ts";$/m);
  assert.match(probe, /^import "\.\.\/\.\.\/src\/controllers\/auth\.ts";$/m);
  // Vitest refuses a file that declares no test, so the probe declares an empty
  // one. It asserts nothing: the imports above are the whole question.
  assert.match(probe, /test\('the modules our guardrails import all load', \(\) => \{\}\)/);

  // And the config names exactly one file to collect: that probe.
  assert.match(config, /include: \[".unitbob\/structural\/__unitbob_boot\.test\.mjs"\]/);
  // Globals, because the probe cannot import `test` from a vitest that may live
  // under `.unitbob/runners/`, out of reach of its own node_modules walk.
  assert.match(config, /globals: true/);
});

// The back door into the project's tests. With `test.projects` (or the older
// `test.workspace`) set, vitest stops deciding anything from the root `include`
// and runs each sub-project's own test files — so inheriting the project's
// config wholesale would open exactly the files this spec stopped opening.
test('vitest: a project workspace cannot widen the check back to the project\'s tests', async () => {
  const projectRoot = vitestProject();
  writeFileSync(
    join(projectRoot, 'vitest.config.ts'),
    'export default { test: { projects: ["packages/*"] } };\n',
  );

  const { config } = await bootFiles(projectRoot);

  // The project's config is still inherited — plugins and aliases are what makes
  // the imports resolve — but those two keys do not come with it.
  assert.match(config, /import projectConfig from "\.\.\/vitest\.config\.ts"/);
  assert.match(config, /const \{ projects, workspace, \.\.\.test \} = base\.test \?\? \{\};/);
  assert.match(config, /test: \{ \.\.\.test, globals: true, include: \[/);
});

// Nothing resolved to a file — a hole in the graph, not a broken application.
// The runner is not started to find that out.
test('vitest: an empty list of sources is nothing to load, and starts nothing', async () => {
  const deps = fakeRunner([{ code: 0 }]);

  assert.deepEqual(await bootCheck(vitestProject(), 'vitest', deps, []), {
    status: 'not_checked',
    reason: 'nothing_to_load',
  });
  assert.deepEqual(deps.calls, []);
});

// A vitest that is installed but cannot be executed. There is no global fallback
// for this stack by design, so the honest answer is that there is no vitest to
// invoke — and nothing is written to find that out.
test('vitest: an installed but unrunnable binary is no runner, not a verdict', async () => {
  const deps = fakeRunner([{ code: 0 }]);

  assert.deepEqual(await bootCheck(vitestProject(0o644), 'vitest', deps), {
    status: 'not_checked',
    reason: 'no_runner',
  });
  // And nothing was spawned to find that out.
  assert.equal(deps.calls.length, 0);
});

// Our own probe was not collected. That says nothing about the project's code,
// so it must not read as a verdict on it.
test('vitest: a run that collected nothing is not checked, not broken', async () => {
  const result = await bootCheck(
    vitestProject(),
    'vitest',
    fakeRunner([{ code: 1, stderr: 'No test files found, exiting with code 1' }]),
  );

  assert.deepEqual(result, { status: 'not_checked', reason: 'nothing_to_load' });
});

// A source file the map named that will not parse. It is one of ours to point
// at now — the probe imports it by name — so "a defect in the code" is a claim
// we can actually stand behind.
test('vitest: a named source that will not parse is broken', async () => {
  const result = await bootCheck(
    vitestProject(),
    'vitest',
    fakeRunner([{ code: 1, stderr: 'Error: Transform failed with 1 error:\nsrc/cart.ts:4:2: ERROR: Expected ")"' }]),
  );

  assert.equal(result.status, 'broken');
  assert.equal(result.status === 'broken' && result.cause, 'defect_in_code');
});

// Nothing to load with is not the same as nothing loading. Each of these three
// leaves us without an answer, and none of them may read as a verdict on the
// code.
test('no runner at all is not checked', async () => {
  assert.deepEqual(await bootCheck(tmpProject(), null, fakeRunner([{ code: 0 }])), {
    status: 'not_checked',
    reason: 'no_runner',
  });
});

test('vitest that is not installed is not checked — and is never installed to find out', async () => {
  const deps = fakeRunner([{ code: 0 }]);
  const result = await bootCheck(tmpProject(), 'vitest', deps);

  assert.deepEqual(result, { status: 'not_checked', reason: 'no_runner' });
  // Reaching for npx would install a package into the user's project to answer
  // a question. Nothing ran at all.
  assert.deepEqual(deps.calls, []);
});

test('a missing boot helper is nothing to load, not a broken app', async () => {
  assert.deepEqual(await bootCheck(tmpProject(), 'rspec', fakeRunner([{ code: 0 }])), {
    status: 'not_checked',
    reason: 'nothing_to_load',
  });
});

// runProcess reports a timeout as a null exit code. Waiting too long says
// nothing about the code, so it must not come back as a defect.
test('a load that runs past the limit is not checked, not broken', async () => {
  assert.deepEqual(await bootCheck(railsProject(), 'rspec', fakeRunner([{ code: null }])), {
    status: 'not_checked',
    reason: 'timed_out',
  });
});

// --- Task 1.2: repair what we may, then ask once more --------------------

function withDatabaseYml(projectRoot: string, body: string): string {
  mkdirSync(join(projectRoot, 'config'), { recursive: true });
  writeFileSync(join(projectRoot, 'config', 'database.yml'), body);
  return projectRoot;
}

const SEPARATE_DATABASES = `development:
  adapter: postgresql
  database: shop_development

test:
  adapter: postgresql
  database: shop_test
`;

const SHARED_DATABASE = `development:
  adapter: postgresql
  database: shop

test:
  adapter: postgresql
  database: shop
`;

test('a failed load is retried once after the test database is prepared', async () => {
  const projectRoot = withDatabaseYml(railsProject(), SEPARATE_DATABASES);
  const deps = fakeRunner([
    { code: 1, stderr: 'ActiveRecord::NoDatabaseError: database "shop_test" does not exist' },
    { code: 0 }, // db:test:prepare
    { code: 0 }, // the retry
  ]);

  assert.deepEqual(await bootCheck(projectRoot, 'rspec', deps), { status: 'ok' });
  assert.match(deps.calls[1], /db:test:prepare/);
  // Once, not in a loop: load, prepare, load. Then the answer stands.
  assert.equal(deps.calls.length, 3);
});

// The one place where being wrong destroys something a re-run cannot restore.
// Every uncertainty resolves to "don't".
test('db:test:prepare is skipped when test and development name the same database', async () => {
  const projectRoot = withDatabaseYml(railsProject(), SHARED_DATABASE);
  const deps = fakeRunner([{ code: 1, stderr: 'ActiveRecord::NoDatabaseError' }]);

  const result = await bootCheck(projectRoot, 'rspec', deps);

  assert.equal(result.status, 'broken');
  assert.equal(deps.calls.length, 1, 'the load was attempted once and nothing was prepared');
  assert.ok(!deps.calls.some((call) => call.includes('db:test:prepare')));
});

test('a database.yml we cannot read two names out of stops the repair', () => {
  // Inherited through an anchor: we cannot resolve it, so we do not act on it.
  assert.equal(
    testDatabaseIsSeparate(
      withDatabaseYml(tmpProject(), 'default: &default\n  database: shop\n\ntest:\n  <<: *default\n'),
    ),
    false,
  );
  // No database.yml at all.
  assert.equal(testDatabaseIsSeparate(tmpProject()), false);
  // Two names we can read, and they differ.
  assert.equal(testDatabaseIsSeparate(withDatabaseYml(tmpProject(), SEPARATE_DATABASES)), true);
});

// The project's own dependencies rewrite Gemfile.lock and package-lock.json,
// which are the user's files — outside the sandbox rule that lets us write a
// sidecar Gemfile and a test database. They are named to the human instead.
// Preparing the test database drops and reloads the schema. Doing that because
// a model has a syntax error is a side effect nobody asked for and a wait that
// buys nothing — the retry would fail on the same line.
test('a failure that is not about the database does not trigger a prepare', async () => {
  const projectRoot = withDatabaseYml(railsProject(), SEPARATE_DATABASES);
  const deps = fakeRunner([{ code: 1, stderr: "app/models/report.rb:1: syntax error, unexpected end (SyntaxError)" }]);

  const result = await bootCheck(projectRoot, 'rspec', deps);

  assert.equal(result.status, 'broken');
  assert.equal(deps.calls.length, 1, 'the load was attempted once and nothing was prepared');
  assert.ok(!deps.calls.some((call) => call.includes('db:test:prepare')));
});

test('the project\'s own dependencies are never installed', async () => {
  const projectRoot = withDatabaseYml(railsProject(), SEPARATE_DATABASES);
  const deps = fakeRunner([{ code: 1, stderr: 'Bundler::GemNotFound: Could not find rake-13.0.6' }, { code: 0 }, { code: 1, stderr: 'Bundler::GemNotFound' }]);

  await bootCheck(projectRoot, 'rspec', deps);

  for (const call of deps.calls) {
    assert.ok(!/bundle install|npm install|pip install/.test(call), `installed dependencies: ${call}`);
  }
});

// --- Task 1.0 regression -------------------------------------------------

// Observed by hand on a2time (2026-08-02) with the broken `report.rb` still in
// place: `unitbob_helper.rb` loads, and the suite goes on to run 80 examples
// with 56 of them green. The spec had assumed the opposite, and the assumption
// is what this test pins: a load that succeeds is `ok` even when the project
// contains a defect that will fail tests later. Answering `broken` here would
// take away a suite that builds and correctly reports what is wrong.
test('a project whose suite starts is ok, even with a defect waiting inside it', async () => {
  const result = await bootCheck(railsProject(), 'rspec', fakeRunner([{ code: 0 }]));

  assert.deepEqual(result, { status: 'ok' });
});

// Spec 36, criterion 8. `docker exec` fails with 125/126/127 for reasons of its
// own — the container stopped between the check and the spawn — and those codes
// collide with real runners'. Unmarked, the exit code reads as "broken" and
// `causeOf` then picks a cause by matching the output against a path pattern:
// somebody would be told a defect was found in their code because a daemon
// refused. It must be able to reach neither verdict.
test('a failure of the place itself never becomes a verdict about the code', async () => {
  const deps: BootCheckDeps = {
    runCmd: async () => ({
      code: 126,
      stdout: '',
      // Full of paths that look exactly like this project's own code — which is
      // what `causeOf` would seize on.
      stderr: 'app/models/billing.rb:12: Error response from daemon: container is not running',
      placeFailure: 'Error response from daemon: container is not running',
    }),
  };

  const result = await bootCheck(railsProject(), 'rspec', deps);

  assert.equal(result.status, 'not_checked');
  assert.equal(result.status === 'not_checked' ? result.reason : '', 'place_failed');
});
