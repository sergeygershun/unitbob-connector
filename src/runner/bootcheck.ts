import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { executable, type ProcResult } from '../proc.ts';
import { projectRootAsSeenByThePlace, runInProject } from './place.ts';
import { commandFileOnHost, locateRunner } from './toolchain.ts';
import { GUARDRAILS_DIR, HELPER_FILE } from '../files/guardrails.ts';
import { PYTEST_INI, PYTEST_INI_FILE } from './pytest.ts';
import { PROVISION_TIMEOUT_MS } from './provision.ts';
import { VITEST_BOOT_CONFIG_FILE, vitestBootConfigSource } from './vitest.ts';

// Spec 32-6. `precheck.ts` looks at marker files and starts nothing; this module
// deliberately does the opposite — it *starts* something, once, before any
// generation begins. The two are not variations of one idea and the comment in
// precheck.ts ("We do not boot anything here") stays true of that file.
//
// What gets started is narrow on purpose. The question is not "is this app
// healthy" but "would the suite get off the ground", and the second question is
// the strictly weaker one. Rails loads lazily in the test environment
// (`config.eager_load = false`), so a broken file nothing touches does not stop
// a suite from running — it comes back as a failing test, which is the product
// working as intended. `Rails.application.eager_load!` would answer the
// stricter question and take a perfectly buildable suite away from the
// vibecoder, so it is not used here.
//
// The condition we test must equal the condition that makes a run impossible,
// never exceed it.
export type BootCheck =
  | { status: 'ok' }
  | {
      status: 'broken';
      cause: 'defect_in_code' | 'environment_not_ready';
      message: string;
      detail: string;
    }
  | {
      status: 'not_checked';
      reason:
        | 'no_runner'
        | 'runner_could_not_answer'
        | 'timed_out'
        | 'nothing_to_load'
        // The place itself did not carry the command out — the container
        // stopped, the image has no such executable (spec 36, criterion 8).
        // Its own state, because it is the one answer that is about neither the
        // runner nor the code.
        | 'place_failed';
      detail?: string;
    };

// Three states, and the third is named for what happened rather than for what
// we know. "Not checked" is a fact about the attempt; "unknown" would be a fact
// about us. The same choice spec 32-4 made between `not_built` and `not_run`.
//
// A fourth state was considered and dropped: it would have behaved exactly like
// `not_checked` while forcing every caller to handle one more branch. The
// descriptive detail lives in `cause`/`reason` instead, and both are closed
// lists, so the sentences a vibecoder reads are identical from run to run and a
// test can pin them.

export interface BootCheckDeps {
  runCmd: (
    command: string,
    args: string[],
    options: { cwd: string; env?: Record<string, string> },
  ) => Promise<ProcResult>;
}

const defaultDeps: BootCheckDeps = {
  runCmd: (command, args, options) =>
    runInProject(options.cwd, command, args, { timeoutMs: PROVISION_TIMEOUT_MS, env: options.env }),
};

// How much of a runner's output rides along in `detail`. Enough to see the
// stack that mattered, short enough that a stop message stays readable.
const DETAIL_LIMIT = 4_000;

// What each stack can and cannot tell us. Printed with the finding rather than
// kept quiet: promising all three stacks the same guarantee is exactly the kind
// of claim spec 32-5 had to go back and delete.
export const SIGNAL_STRENGTH: Record<string, string> = {
  rspec:
    'Full signal on this stack: the check loads the very file the suite starts from, ' +
    'so whatever stops one stops the other.',
  pytest:
    'Full signal on the files it names: the check imports the very modules the guardrails of this ' +
    "branch will import, and nothing else — none of this project's own tests are opened. Code that " +
    'no guardrail imports was not looked at.',
  vitest:
    'Full signal on the files it names: the check imports the very modules the guardrails of this ' +
    "branch will import, through this project's own vite configuration, and nothing else — none of " +
    "the project's own tests are opened. Types are not checked (vite strips them without checking " +
    'them), and code no guardrail imports was not looked at.',
};

// Does the suite for this stack get off the ground? One attempt, one answer.
//
// `sourceFiles` are the project's own source files this branch's guardrails will
// import, resolved from the map (spec 38). They are what gets loaded on the two
// stacks that have no boot file of their own — never the project's test tree.
// Ruby ignores the list: its helper is the suite's real first line and already
// pulls the application up behind it.
export async function bootCheck(
  projectRoot: string,
  runner: string | null,
  sourceFiles: string[],
  deps: BootCheckDeps = defaultDeps,
): Promise<BootCheck> {
  switch (runner) {
    case 'rspec':
      return rubyBootCheck(projectRoot, deps);
    case 'pytest':
      return pytestBootCheck(projectRoot, sourceFiles, deps);
    case 'vitest':
      return vitestBootCheck(projectRoot, sourceFiles, deps);
    default:
      return { status: 'not_checked', reason: 'no_runner' };
  }
}

// Ruby: load `.unitbob/structural/unitbob_helper.rb` under RAILS_ENV=test. That
// is not a stand-in for the suite's boot — it *is* the suite's boot. The
// generated spec's first line requires this exact file, and the helper hands off
// to the project's own `spec/rails_helper.rb` when there is one, so factories,
// `spec/support` and the project's own configuration all come along for free,
// without this module knowing anything about them.
async function rubyBootCheck(projectRoot: string, deps: BootCheckDeps): Promise<BootCheck> {
  const helper = `${GUARDRAILS_DIR}/${HELPER_FILE}`;
  if (!existsSync(join(projectRoot, helper))) return { status: 'not_checked', reason: 'nothing_to_load' };

  const first = await loadRubyHelper(projectRoot, helper, deps);
  if (first.status !== 'broken') return first;

  // Repair what we are allowed to repair, then ask once more. A vibecoder has
  // no test database — demanding one would turn away nearly every user we have.
  // Never in a loop: one attempt, one retry, then the answer stands.
  //
  // Only when the failure is about the database, though. Preparing it is not
  // free — it drops and reloads the schema, tens of seconds on a large app —
  // and doing that in response to a syntax error is a side effect nobody asked
  // for and a wait that buys nothing.
  if (!looksLikeDatabase(first.detail)) return first;
  if (!(await prepareTestDatabase(projectRoot, deps))) return first;

  return loadRubyHelper(projectRoot, helper, deps);
}

// Is this failure about the database at all? Kept as one broad signal rather
// than a list of adapter error classes — the same reason the cause heuristics
// stay generic. Being wrong here is cheap in one direction (a preparation we
// did not need) and cheap in the other (we return the failure we already have,
// which is honest either way).
function looksLikeDatabase(detail: string): boolean {
  return /database|migration|schema|ActiveRecord::(NoDatabase|StatementInvalid|PendingMigration)/i.test(detail);
}

async function loadRubyHelper(
  projectRoot: string,
  helper: string,
  deps: BootCheckDeps,
): Promise<BootCheck> {
  // `executable`, not `existsSync` — the same test `runRspecSuite` makes of
  // `bin/rspec`, and for the same reason. A binstub that is present but not
  // executable makes `spawn` throw, `attempt` return null, and the answer come
  // back `no_runner`: "no runner available to load your suite with", said to
  // someone whose bundler is installed and working. That is the mistake
  // `runner_could_not_answer` was added to stop making,
  // and the global `bundle` was standing right there the whole time.
  const command = executable(join(projectRoot, 'bin', 'bundle')) ? 'bin/bundle' : 'bundle';

  // When Unitbob installed rspec-rails for itself, the gems this helper needs
  // are resolved by the sidecar Gemfile, not the project's. Asking bundler
  // without that variable would load a different set of gems than the run does,
  // which is exactly the way a check ends up predicting the wrong thing.
  const located = locateRunner(projectRoot, 'rspec');

  // `require "./…"`, and the leading dot is not cosmetic: Ruby resolves a
  // relative require against `$LOAD_PATH`, which does not hold the working
  // directory, and only a path beginning with `.` is resolved against the
  // working directory instead. The helper finds its own neighbours through
  // `__dir__`, which is absolute however the file was reached, so nothing else
  // about it changes.
  return classify(
    projectRoot,
    'rspec',
    await attempt(deps, command, ['exec', 'ruby', '-e', `require ${JSON.stringify(`./${helper}`)}`], {
      cwd: projectRoot,
      env: {
        ...located?.env,
        RAILS_ENV: 'test',
        UNITBOB_REPO_ROOT: projectRootAsSeenByThePlace(projectRoot),
      },
    }),
    // A clean load says nothing on stdout and exits 0. Anything else is the
    // suite failing to start.
    (result) => (result.code === 0 ? 'ok' : 'broken'),
  );
}

// Python: run one test file of our own, which imports the modules the
// guardrails will import. Not `--collect-only`, and not the project's test tree:
// what the run would do first is import *our* suite's targets, and asking pytest
// to collect everything it can find asks about files this product never touches
// (spec 38, criterion 1).
//
// `-c` with an empty-addopts config, exactly as `runPytestSuite` does and for
// exactly its reason: the project's own `addopts` (`--cov`, `-n auto`) must not
// decide the answer. Without it a project whose `pytest.ini` asks for a plugin
// that is not installed came back `broken` — a healthy application refused over
// a `--cov` flag. The run path had already solved this; the check had not
// inherited the solution, which also made it *stricter* than the thing it
// predicts, the one rule this whole check is built on.
async function pytestBootCheck(projectRoot: string, sourceFiles: string[], deps: BootCheckDeps): Promise<BootCheck> {
  if (sourceFiles.length === 0) return { status: 'not_checked', reason: 'nothing_to_load' };

  // Its own directory, rather than relying on `materializeHelper` having run
  // first: this check must not fail because a different step was skipped.
  mkdirSync(join(projectRoot, dirname(PYTEST_INI_FILE)), { recursive: true });
  writeFileSync(join(projectRoot, PYTEST_INI_FILE), PYTEST_INI);

  // The same pytest the run will use, resolved once in `locateRunner` — the
  // sidecar under `.unitbob/` when Unitbob installed one, else the machine's own
  // interpreter. Asking a different interpreter than the run uses is how a check
  // ends up answering about something nobody is going to execute.
  //
  // When it resolves nothing we still try the two interpreters by name rather
  // than reporting `no_runner` from a lookup. The lookup is a prediction; the
  // spawn is the fact, and a check that stops at its own prediction can be
  // wrong in the one direction that costs the most — refusing a project that
  // would have answered perfectly well.
  const located = locateRunner(projectRoot, 'pytest');
  const candidates = located
    ? [located]
    : [
        { command: 'python3', args: ['-m', 'pytest'], env: undefined },
        { command: 'python', args: ['-m', 'pytest'], env: undefined },
      ];

  return withProbe(projectRoot, { [PYTEST_PROBE_FILE]: pytestProbeSource(sourceFiles) }, async () => {
    for (const candidate of candidates) {
      // The probe's path is passed explicitly, and it has to be: `.unitbob` is a
      // hidden directory, which pytest's default `norecursedirs` skips. Without
      // the path it would collect the project's tests and not ours — the exact
      // mistake this spec removes.
      const result = await attempt(
        deps,
        candidate.command,
        [...candidate.args, '-c', PYTEST_INI_FILE, '--rootdir', '.', PYTEST_PROBE_FILE, '-q'],
        { cwd: projectRoot, env: candidate.env },
      );
      if (result === null) continue; // this interpreter is not on the machine

      return classify(projectRoot, 'pytest', result, (proc) => pytestVerdict(proc.code));
    }
    return { status: 'not_checked', reason: 'no_runner' };
  });
}

// pytest's own exit vocabulary, used rather than "zero or not". The distinction
// that matters is between "your code did not load" and "pytest itself could not
// be asked", and only the first is an answer about the project.
function pytestVerdict(code: number | null): Verdict {
  // `classify` turns a timeout into `timed_out` before asking, so this is
  // unreachable — but "no exit code" can only ever mean "we learned nothing".
  if (code === null) return 'runner_could_not_answer';
  // 5 — collected nothing. Since spec 38 the only file offered for collection is
  // our own probe, so this now means "our probe was not collected", not "this
  // project has no tests". Still not a verdict on the code either way.
  if (code === 5) return 'nothing_to_load';
  // 3 — internal error, 4 — bad usage. Both are about the invocation, not the
  // project, so neither may read as "your suite cannot start".
  if (code === 3 || code === 4) return 'runner_could_not_answer';
  return code === 0 ? 'ok' : 'broken';
}

// JS/TS: run one test file of our own, which imports the source files the
// guardrails will import.
//
// It used to be `vitest list`, which parses and imports *every* test file the
// project has. That answered about somebody else's tests: a jest project came
// back "found a defect that stops your test suite from starting" because its own
// suites, green under jest, do not define `describe` under vitest. We do not
// need the project's tests — we write our own — so we stopped opening them
// (spec 38, criterion 1).
//
// Why a test file rather than a plain import: a test runner has no "load this
// module and tell me if it exploded" command, and a bare `node` cannot stand in,
// because TypeScript, JSX, path aliases and bundler plugins are exactly what
// vite resolves from the project's own config. So the probe is a legal vitest
// test that asserts nothing and imports everything named. Ruby has done the same
// since spec 29, through `unitbob_helper.rb`.
//
// `tsc --noEmit` is deliberately not used. It answers a different question —
// are the types sound — and a project with a hundred type errors runs perfectly
// well, because vite, esbuild and tsx strip types without checking them. Type
// errors accumulate for years in healthy codebases; calling that "broken" would
// turn away the majority. A file that is genuinely unparseable is caught here
// anyway, since the probe's import has to parse it.
async function vitestBootCheck(projectRoot: string, sourceFiles: string[], deps: BootCheckDeps): Promise<BootCheck> {
  // Nothing the map resolved to a file, so there is nothing to import. That is a
  // hole in the graph, not a broken application, and the run carries on.
  if (sourceFiles.length === 0) return { status: 'not_checked', reason: 'nothing_to_load' };

  // A sidecar vitest counts as installed: it is ours, it is on disk, and it is
  // the one the run will spawn. What stays out is `npx`, for the reason below.
  const local = locateRunner(projectRoot, 'vitest')?.command ?? 'node_modules/.bin/vitest';
  // Only a vitest already installed in the project is used. Reaching for `npx`
  // would install a package to answer a question, and installing into the
  // user's project is not this check's business.
  //
  // `executable`, not `existsSync`, and there is no fallback to go to: an
  // unrunnable binary sends `spawn` into EACCES and there is nothing left to
  // ask. `no_runner` is the honest answer: there is no vitest this check can
  // invoke.
  if (!executable(commandFileOnHost(projectRoot, local))) return { status: 'not_checked', reason: 'no_runner' };

  return withProbe(
    projectRoot,
    {
      [VITEST_PROBE_FILE]: vitestProbeSource(sourceFiles),
      [VITEST_BOOT_CONFIG_FILE]: vitestBootConfigSource(projectRoot, VITEST_PROBE_FILE),
    },
    async () => {
      // `run`, which every version of vitest has. The version probe that used to
      // stand here existed only for the `list` subcommand, which arrived in 2.1 —
      // with it goes the `runner_too_old` answer, and with that the case where a
      // perfectly good runner was declined for its age.
      const result = await attempt(deps, local, ['run', '--config', VITEST_BOOT_CONFIG_FILE], { cwd: projectRoot });
      return classify(projectRoot, 'vitest', result, (proc) => {
        if (proc.code === 0) return 'ok';
        // Our own probe was not collected. It says nothing about the project's
        // code, so it must not read as a verdict on it.
        if (/no test files found/i.test(`${proc.stdout}\n${proc.stderr}`)) return 'nothing_to_load';
        return 'broken';
      });
    },
  );
}

// The probe: one test that asserts nothing and imports everything the map named.
//
// The vitest probe lives beside the generated suite because that is where the
// suite's own imports will resolve from; `materializeGuardrails` wipes that
// directory before writing a suite, and by then the probe is long gone.
const VITEST_PROBE_FILE = `${GUARDRAILS_DIR}/__unitbob_boot.test.mjs`;

// `test_` first, on purpose: pytest collects a file by that prefix whatever the
// project's own `python_files` setting says.
const PYTEST_PROBE_FILE = `${GUARDRAILS_DIR}/test_unitbob_boot.py`;

// Every file this check puts in somebody's project, written together and removed
// together whatever happens — the way `worldProbe` treats its own. One of them
// left behind would be collected by the project's next test run, and changing
// what that run does is not ours to do.
//
// Both stacks go through here, so the write and the removal cannot drift apart
// on one of them.
async function withProbe<T>(
  projectRoot: string,
  files: Record<string, string>,
  ask: () => Promise<T>,
): Promise<T> {
  for (const [relativePath, source] of Object.entries(files)) {
    const path = join(projectRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }

  try {
    return await ask();
  } finally {
    for (const relativePath of Object.keys(files)) rmSync(join(projectRoot, relativePath), { force: true });
  }
}

// Relative from the probe, which sits two levels down (`.unitbob/structural/`).
// The empty test is not decoration: vitest fails a file that declares none, and
// `globals: true` in the config we write is what lets it be named without an
// import (see `writeVitestBootConfig`).
function vitestProbeSource(sourceFiles: string[]): string {
  const imports = sourceFiles.map((file) => `import ${JSON.stringify(`../../${file}`)};`).join('\n');
  return `// Written by the unitbob connector before the boot check — do not edit.
${imports}

test('the modules our guardrails import all load', () => {});
`;
}

// Python imports modules, not files, so the probe does the translation itself —
// and then imports by name, exactly as a guardrail's `from app.models import
// User` will (spec 50). Not `spec_from_file_location` + `exec_module`, which is
// what stood here until 2026-09-11: that executes the file whether or not it is
// already loaded. On microblog the first target, `app/__init__.py`, does `from
// app import models`, so by the time the loop reached `app/models.py` the module
// was in `sys.modules` and got run a second time — SQLAlchemy answered "Table
// 'followers' is already defined for this MetaData instance", and a healthy
// Flask application lost its structural branch. `import_module` reads
// `sys.modules` first, names `app/__init__.py` `app` rather than `app.__init__`,
// and goes through the finders, so the probe asks the run's question and no
// stricter one (`docs/adr/0001`). Where it still differs: `sys.path.insert(0,
// ROOT)` puts the project root first, which `-m pytest` run from that root does
// on its own — every interpreter `locateRunner` returns is invoked that way — so
// the line is the run's assumption made visible, not an addition to it. A
// src-layout project, whose guardrails import `pkg.mod` with `src/` on the
// path, is named `src.pkg.mod` here and would be refused; no such project has
// reached the bench, and the spec records it as work not done.
function pytestProbeSource(sourceFiles: string[]): string {
  return `# Written by the unitbob connector before the boot check — do not edit.
import importlib
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
TARGETS = ${JSON.stringify(sourceFiles)}


def test_the_modules_our_guardrails_import_all_load():
    for rel in TARGETS:
        # A path we cannot build a module out of is our resolution falling
        # short, never this project's code, so it is passed over in silence.
        # Blaming somebody's application for a name our own map handed us is
        # the whole mistake this check was rewritten to stop making.
        if not rel.endswith(".py"):
            continue
        name = rel[:-3].replace("/", ".")
        if name.endswith(".__init__"):
            name = name[: -len(".__init__")]
        importlib.import_module(name)
`;
}

// Runs one command, turning "this binary is not on the machine" into null (the
// caller decides whether that means `no_runner` or "try the next interpreter")
// and a timeout into a ProcResult with a null code, as runProcess already does.
async function attempt(
  deps: BootCheckDeps,
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<ProcResult | null> {
  try {
    return await deps.runCmd(command, args, options);
  } catch {
    return null;
  }
}

// What one attempt is allowed to conclude. `runner_could_not_answer` is not
// `no_runner`: the runner is installed and was reached, it simply refused the
// question — a bad invocation, an internal error of its own. Saying "no runner
// available" to someone whose pytest is right there sends them to fix something
// that is not broken.
type Verdict = 'ok' | 'broken' | 'nothing_to_load' | 'runner_could_not_answer';

function classify(
  projectRoot: string,
  runner: string,
  result: ProcResult | null,
  verdict: (proc: ProcResult) => Verdict,
): BootCheck {
  if (result === null) return { status: 'not_checked', reason: 'no_runner' };
  // runProcess reports a timeout as a null exit code. Waiting too long tells us
  // nothing about the code, so it must not read as a defect.
  if (result.code === null) return { status: 'not_checked', reason: 'timed_out' };
  // Before the exit code is read at all, and that order is the whole point. The
  // codes docker returns for its own failures overlap with real runners' codes,
  // and one step further down `causeOf` picks a cause by matching the output
  // against a path pattern — so a container that stopped mid-run could come back
  // as "found a defect that stops your test suite from starting". An accusation
  // about somebody's code, for a failure of the daemon.
  if (result.placeFailure) return { status: 'not_checked', reason: 'place_failed', detail: result.placeFailure };

  const outcome = verdict(result);
  if (outcome === 'ok') return { status: 'ok' };
  if (outcome === 'nothing_to_load') return { status: 'not_checked', reason: 'nothing_to_load' };
  // Nothing was learned about the project, and saying otherwise would be the
  // lie this check exists to remove.
  if (outcome === 'runner_could_not_answer') return { status: 'not_checked', reason: 'runner_could_not_answer' };

  const output = `${result.stdout}\n${result.stderr}`.trim();
  return {
    status: 'broken',
    cause: causeOf(output, projectRoot, runner),
    message: firstErrorLine(output),
    detail: output.length > DETAIL_LIMIT ? `${output.slice(0, DETAIL_LIMIT)}\n…` : output,
  };
}

// One concept, not a catalogue of known errors — the lesson spec 32-2 drew from
// the over-fitted regex scanner of 32-3. "A name that does not resolve to a file
// inside this project" is the single class of failure that, in all three
// languages, reaches project code while still being a setup step rather than a
// defect.
const DEPENDENCY_MISSING = [
  /\bLoadError\b/,
  /Bundler::GemNotFound/,
  /\bModuleNotFoundError\b/,
  /Cannot find module\b/,
  /Failed to resolve import\b/,
];

// Which of the two sentences the vibecoder reads. It changes wording only —
// both outcomes stop the run, because in both cases every test would die before
// asserting anything. That is why getting this wrong is cheap: the first draft
// of this spec let the same distinction decide whether to stop at all, and
// there a misclassification would have refused a healthy project.
function causeOf(output: string, projectRoot: string, runner: string): 'defect_in_code' | 'environment_not_ready' {
  if (DEPENDENCY_MISSING.some((pattern) => pattern.test(output))) return 'environment_not_ready';
  return hasProjectFrame(output, projectRoot, runner) ? 'defect_in_code' : 'environment_not_ready';
}

// Both halves are needed, and reasoning from Rails alone hides that. Ruby
// resolves gems through `bundler/setup` before the first application file, so a
// missing gem there reliably produces a trace with no project frame in it.
// Python and JS have no such gate — the import is resolved from inside a project
// file:
//
//   tests/test_foo.py:3: in <module>
//       import requests
//   E   ModuleNotFoundError: No module named 'requests'
//
// There is a project frame, and it is an un-run `pip install`. Hence the second
// condition above.
function hasProjectFrame(output: string, projectRoot: string, runner: string): boolean {
  // Line by line, because a stack frame names one file and the question is
  // asked of that file. Judging the whole output at once let `.venv/lib/...`
  // answer yes on the strength of its `lib/`, which is how a `TypeError` deep
  // inside a dependency came back as a defect in the user's code.
  const ownDirs = CONVENTIONAL_SOURCE_DIRS[runner] ?? [];
  const conventional = ownDirs.length
    ? new RegExp(`(^|[\\s"'(\\[/])(${ownDirs.join('|')})/`)
    : null;

  for (const line of output.split('\n')) {
    // Wherever a dependency is installed, it is not this project's code — and
    // that has to be decided before anything below gets a chance to say yes.
    if (INSTALLED_DEPENDENCY.test(line)) continue;

    // The conventional homes of business code, relative or absolute.
    if (conventional?.test(line)) return true;
    if (line.includes(projectRoot)) return true;

    // Python names no fixed layout the way Rails does, and pytest prints frames
    // relative to the working directory — `mypackage/billing.py:12`, matching
    // neither of the two rules above. So fall back to the only thing that
    // generalises: the file in this frame is a file this repository has.
    //
    // Data-driven, so it needs no list of package names and holds for
    // src-layout, flat-layout and anything else. Without it a genuine
    // `NameError` in the user's own module was reported as "your environment is
    // not ready", sending them to run `pip install` over a typo.
    for (const [, candidate] of line.matchAll(SOURCE_FRAME)) {
      if (existsSync(join(projectRoot, candidate))) return true;
    }
  }

  return false;
}

// Where each stack conventionally keeps its business code. Only a stack that
// really has such a convention gets an entry: `app/` and `lib/` are Rails, and
// they used to be the fallback for everything that was not vitest, which meant a
// Python project got Rails's layout applied to its stack traces. Python names no
// fixed layout at all, so it is deliberately absent — the repository-file test
// below is the answer there, and it is the more reliable one anyway.
const CONVENTIONAL_SOURCE_DIRS: Record<string, string[]> = {
  rspec: ['app', 'lib'],
  cucumber: ['app', 'lib'],
  vitest: ['src'],
  'cucumber-js': ['src'],
};

// Where a dependency lives once installed — never the project's own code, in
// any of the three languages. The last two are the languages' own installed
// libraries: `…/lib/ruby/3.3.0/psych.rb` is a frame the `lib/` rule below would
// otherwise read as this project's business code.
const INSTALLED_DEPENDENCY =
  /site-packages|dist-packages|node_modules|[/.]venv[/\\]|\/gems\/|[/\\]lib[/\\]ruby[/\\]|[/\\]lib[/\\]python\d/;

// A `path/to/file.ext:LINE` frame, as every one of these runners prints them.
const SOURCE_FRAME = /([\w.\-/\\]+\.(?:py|rb|ts|tsx|js|jsx|mjs|cjs)):\d+/g;

// The runner's own words, never a paraphrase. A vibecoder can search for this
// string; a summary of it they cannot. File and line come along when the runner
// put them on the same line, and are not manufactured when it did not.
//
// Exported because spec 32-7 asks a second tool to load the application (the
// router), and one rule for quoting a failed load is better than two.
export function firstErrorLine(output: string): string {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const looksLikeError =
    /(^|[^A-Za-z])(error|exception|traceback)|:\d+:in |^E\s|\(.*Error\)/i;
  return lines.find((line) => looksLikeError.test(line)) ?? lines[0] ?? 'the runner exited without output';
}

// The one repair this check performs. A test database is not a repository file
// and is disposable by nature, which puts it under the same rule that already
// lets `provision.ts` write its own Gemfile and venv: everything inside our own
// sandbox, nothing of the project's touched.
//
// The project's own dependencies (`bundle install`, `npm install`,
// `pip install`) stay off-limits for exactly that reason — they rewrite
// `Gemfile.lock` and `package-lock.json`, which are the user's files. Those are
// named to the human instead.
//
// Returns whether the repair ran, so the caller knows whether a retry is worth
// anything.
async function prepareTestDatabase(projectRoot: string, deps: BootCheckDeps): Promise<boolean> {
  if (!testDatabaseIsSeparate(projectRoot)) return false;

  const useBinstub = executable(join(projectRoot, 'bin', 'rails'));
  const command = useBinstub ? 'bin/rails' : 'bundle';
  const args = useBinstub ? ['db:test:prepare'] : ['exec', 'rails', 'db:test:prepare'];

  const result = await attempt(deps, command, args, {
    cwd: projectRoot,
    env: { RAILS_ENV: 'test', UNITBOB_REPO_ROOT: projectRootAsSeenByThePlace(projectRoot) },
  });
  return result !== null && result.code === 0;
}

// Refuse to prepare unless we can positively read two different database names.
// Getting this wrong destroys a person's working data, which is not recoverable
// by re-running anything, so every uncertainty resolves to "don't": no
// database.yml, no `test:` block, a name we cannot read through ERB, or two
// names that match — all of them stop the step.
export function testDatabaseIsSeparate(projectRoot: string): boolean {
  const path = join(projectRoot, 'config', 'database.yml');
  if (!existsSync(path)) return false;

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }

  const test = databaseNameIn(text, 'test');
  const development = databaseNameIn(text, 'development');
  if (!test || !development) return false;
  return test !== development;
}

// The `database:` of one top-level environment block. Deliberately textual: the
// connector carries no YAML parser, database.yml is routinely full of ERB, and
// a name inherited through a `<<: *default` anchor is one we cannot resolve —
// all of which come back as undefined and stop the step, which is the safe
// direction to be wrong in.
function databaseNameIn(text: string, environment: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${environment}:\\s*(#.*)?$`).test(line));
  if (start === -1) return null;

  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level block began
    const match = /^\s+database:\s*(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return null;
}
