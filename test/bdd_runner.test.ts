// The connector-owned BDD strategies (spec 32): one runner per stack, the raw
// report read back from the file the runner wrote, and the pytest-bdd reporter
// plugin the connector ships. Host-provided command strings are never executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { bddStepLoading, runBddSuite } from '../src/runner/bdd.ts';
import { PYTEST_BDD_PLUGIN } from '../src/runner/pytestBddPlugin.ts';

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-bdd-'));
  mkdirSync(join(dir, '.unitbob', 'behavioral', 'features'), { recursive: true });
  mkdirSync(join(dir, '.unitbob', 'behavioral', 'step_definitions'), { recursive: true });
  return dir;
}

function fakeBinDir(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-fake-bin-'));
  writeExecutable(join(dir, name), body);
  return dir;
}

function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

async function withPath(dir: string, fn: () => Promise<void>): Promise<void> {
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
  try {
    await fn();
  } finally {
    process.env.PATH = oldPath;
  }
}

test('cucumber strategy reads the Cucumber Messages report the runner wrote', async () => {
  const projectRoot = tmpProject();
  const report = '{"testCaseStarted":{"id":"s1"}}';
  writeFileSync(join(projectRoot, '.unitbob', 'behavioral', 'Gemfile'), 'gem "cucumber"\n');
  const fakeBin = fakeBinDir(
    'bundle',
    `test "$BUNDLE_GEMFILE" = ".unitbob/behavioral/Gemfile" || exit 4\nmkdir -p .unitbob/behavioral; printf '${report}' > .unitbob/behavioral/cucumber_messages.ndjson`,
  );

  await withPath(fakeBin, async () => {
    const result = await runBddSuite(projectRoot, 'cucumber', '.unitbob/behavioral/features/surface_contracts.feature');
    assert.equal(result.report, report);
    assert.equal(result.resultPath, '.unitbob/behavioral/cucumber_messages.ndjson');
    assert.deepEqual(result.args.slice(0, 2), ['exec', 'cucumber']);
  });
});

test('cucumber strategy reports a missing sidecar instead of falling back to the project bundle', async () => {
  await assert.rejects(
    () => runBddSuite(tmpProject(), 'cucumber', '.unitbob/behavioral/features/surface_contracts.feature'),
    /Behavioral runner missing.*suite-prepare/,
  );
});

test('cucumber-js strategy runs the provisioned sidecar with the message formatter', async () => {
  const projectRoot = tmpProject();
  const report = '{"testCaseStarted":{"id":"s2"}}';
  const sidecarBin = join(projectRoot, '.unitbob', 'behavioral', 'node_modules', '.bin', 'cucumber-js');
  writeExecutable(sidecarBin, `mkdir -p .unitbob/behavioral; printf '${report}' > .unitbob/behavioral/cucumber_messages.ndjson`);

  const result = await runBddSuite(projectRoot, 'cucumber-js', '.unitbob/behavioral/features/surface_contracts.feature');
  assert.equal(result.command, sidecarBin);
  assert.equal(result.report, report);
  assert.ok(result.args.some((arg) => arg.startsWith('message:')), 'uses the message formatter to a file');
});

test('cucumber-js strategy reports a missing sidecar instead of invoking npx', async () => {
  await assert.rejects(
    () => runBddSuite(tmpProject(), 'cucumber-js', '.unitbob/behavioral/features/surface_contracts.feature'),
    /Behavioral runner missing.*suite-prepare/,
  );
});

test('pytest-bdd strategy writes its ini + plugin and reads the connector report', async () => {
  const projectRoot = tmpProject();
  const report = '{"version":1,"scenarios":[]}';
  const sidecarPytest = join(projectRoot, '.unitbob', 'behavioral', '.venv', 'bin', 'pytest');
  writeExecutable(sidecarPytest, `printf '%s' '${report}' > "$UNITBOB_PYTEST_BDD_REPORT"`);

  const result = await runBddSuite(projectRoot, 'pytest-bdd', '.unitbob/behavioral/features/surface_contracts.feature');
  assert.equal(result.command, sidecarPytest);
  assert.equal(result.report, report);
  assert.equal(result.resultPath, '.unitbob/behavioral/pytest_bdd_report.json');
});

test('pytest-bdd strategy reports a missing sidecar instead of using system pytest', async () => {
  await assert.rejects(
    () => runBddSuite(tmpProject(), 'pytest-bdd', '.unitbob/behavioral/features/surface_contracts.feature'),
    /Behavioral runner missing.*suite-prepare/,
  );
});

test('an unknown BDD runner is rejected, never guessed', async () => {
  await assert.rejects(() => runBddSuite(tmpProject(), 'behave', 'x.feature'), /Unsupported BDD runner/);
});

// Spec 43, §3.5–3.6. The recipe told writers to name pytest step files
// `<capability>_steps.py`; pytest collects `test_*.py` and nothing else, so such
// a file would have loaded silently as nothing at all — no error, a green run
// over zero scenarios. What was missing was not a better sentence in the recipe
// but a check that the name the product hands out and the name the command
// collects are the same name. These are that check, one per strategy, and each
// asserts both halves so that editing either one alone turns it red.
const STEPS_DIR = join('.unitbob', 'behavioral', 'step_definitions');

// The set a `--require` glob actually collects, so a test can ask whether the
// descriptor's pattern and the command's glob mean the same files rather than
// comparing two literals and calling that agreement. Comparing literals is how
// the cucumber-js descriptor claimed for a while that a `.ts` file is "never
// executed", while the glob handed it to `require()` and the run died on it.
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*')}$`);
}

function named(runner: string, capability: string): string {
  const pattern = bddStepLoading(runner)?.step_files;
  assert.ok(pattern, `${runner} states no filename pattern`);
  return join(STEPS_DIR, pattern.replace('*', capability));
}

test('pytest-bdd collects exactly the filenames its descriptor promises', async () => {
  const projectRoot = tmpProject();
  const sidecarPytest = join(projectRoot, '.unitbob', 'behavioral', '.venv', 'bin', 'pytest');
  writeExecutable(sidecarPytest, `printf '%s' '{"version":1,"scenarios":[]}' > "$UNITBOB_PYTEST_BDD_REPORT"`);

  const result = await runBddSuite(projectRoot, 'pytest-bdd', '.unitbob/behavioral/features/x.feature');

  // Half one: the product's promise. Verified against a real pytest 9 under
  // this exact ini — `test_signing_in.py` is collected, `signing_in_steps.py` is
  // not, and nothing says so.
  assert.equal(bddStepLoading('pytest-bdd')?.step_files, 'test_*.py');
  // Half two: nothing in the run widens or narrows pytest's own default, which
  // is where `test_*.py` comes from. A `python_files` line here — however
  // reasonable — silently makes the promise above a lie.
  const ini = readFileSync(join(projectRoot, '.unitbob', 'behavioral', 'pytest.ini'), 'utf8');
  assert.doesNotMatch(ini, /python_files/);
  // And the default is two patterns, not one. The name the product hands out is
  // the first; a coordinator who names `signing_in_test.py` must not be told by
  // us that their collected file was not collected.
  assert.ok(
    bddStepLoading('pytest-bdd')?.requirements.some((line) => line.includes('`test_*.py` and `*_test.py`')),
    'the descriptor states both halves of pytest\'s default, not just the one we hand out',
  );
  // And that the run really is made under that ini, over that directory.
  assert.ok(result.args.includes('-c'), 'pytest runs under a connector-owned ini');
  assert.ok(result.args.includes(join('.unitbob', 'behavioral', 'pytest.ini')));
  assert.ok(result.args.includes(STEPS_DIR), 'pytest is pointed at the step-definition directory');
});

test('cucumber loads exactly the filenames its descriptor promises', async () => {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, '.unitbob', 'behavioral', 'Gemfile'), 'gem "cucumber"\n');
  const fakeBin = fakeBinDir('bundle', "mkdir -p .unitbob/behavioral; printf '{}' > .unitbob/behavioral/cucumber_messages.ndjson");

  await withPath(fakeBin, async () => {
    const result = await runBddSuite(projectRoot, 'cucumber', '.unitbob/behavioral/features/x.feature');

    assert.equal(bddStepLoading('cucumber')?.step_files, '*.rb');
    // Cucumber Ruby filters by extension itself — `registry_and_more.rb`:
    // `return unless File.extname(code_file) == '.rb'` — so here the pattern and
    // what runs really are the same set, and a `.md` left in the directory is
    // ignored rather than executed. The pair that can drift is the directory:
    // point `--require` anywhere narrower and the promise stops describing what
    // runs.
    assert.equal(result.args[result.args.indexOf('--require') + 1], STEPS_DIR);
    assert.ok(globToRegExp(join(STEPS_DIR, '*')).test(named('cucumber', 'signing_in')));
  });
});

test('cucumber-js loads exactly the filenames its descriptor promises', async () => {
  const projectRoot = tmpProject();
  const sidecarBin = join(projectRoot, '.unitbob', 'behavioral', 'node_modules', '.bin', 'cucumber-js');
  writeExecutable(sidecarBin, "mkdir -p .unitbob/behavioral; printf '{}' > .unitbob/behavioral/cucumber_messages.ndjson");

  const result = await runBddSuite(projectRoot, 'cucumber-js', '.unitbob/behavioral/features/x.feature');
  const collects = globToRegExp(result.args[result.args.indexOf('--require') + 1]);

  // A file named the way the descriptor says to name it is one the command
  // really collects. This is the agreement Task 3.5 is about, asserted as set
  // membership rather than as two literals that happen to sit near each other.
  assert.ok(collects.test(named('cucumber-js', 'signing_in')), 'a file named as promised is collected');

  // This strategy collects strictly more than it tells you to write, and the
  // difference is not harmless: cucumber-js `require()`s whatever the glob
  // matches, so a stray `.ts` is not ignored — it is executed as JavaScript and
  // kills the run before the first scenario. Verified against cucumber-js 10:
  // a `.ts` beside the steps exits 1 with a SyntaxError and runs nothing.
  //
  // A descriptor may state a narrower rule than the command collects only while
  // it also states the hazard. Widen the glob or drop the warning and this
  // reddens.
  assert.ok(collects.test(join(STEPS_DIR, 'signing_in.ts')), 'the command collects more than the pattern names');
  assert.ok(
    bddStepLoading('cucumber-js')?.requirements.some((line) =>
      /whatever the extension/.test(line) && /aborts the/.test(line)),
    'the descriptor warns that every file in the directory is executed, not just the ones it names',
  );
  assert.ok(!result.args.some((arg) => /ts-node|tsx|--loader|--import/.test(arg)), 'no TypeScript loader is registered');
});

test('every runner this connector will execute states how its steps are loaded', async () => {
  for (const runner of ['cucumber', 'cucumber-js', 'pytest-bdd']) {
    const loading = bddStepLoading(runner);
    assert.ok(loading, `${runner} runs but says nothing about which step files it loads`);
    assert.ok(loading.requirements.length > 0, `${runner} states no requirements for a step file`);
  }
  // A runner the connector will not execute has no rule to state either, and the
  // two answers come from the same table so they cannot disagree.
  assert.equal(bddStepLoading('behave'), null);
  await assert.rejects(() => runBddSuite(tmpProject(), 'behave', 'x.feature'), /Unsupported BDD runner/);
  // Not a strategy, and an inherited property must not look like one.
  assert.equal(bddStepLoading('constructor'), null);
  await assert.rejects(() => runBddSuite(tmpProject(), 'constructor', 'x.feature'), /Unsupported BDD runner/);
});

test('the pytest-bdd plugin hangs off the public pytest-bdd hooks and writes JSON', () => {
  for (const hook of [
    'pytest_bdd_before_scenario',
    'pytest_bdd_after_step',
    'pytest_bdd_step_error',
    'pytest_bdd_after_scenario',
  ]) {
    assert.match(PYTEST_BDD_PLUGIN, new RegExp(`def ${hook}\\(`));
  }
  assert.match(PYTEST_BDD_PLUGIN, /json\.dump/);
  assert.match(PYTEST_BDD_PLUGIN, /UNITBOB_PYTEST_BDD_REPORT/);
});
