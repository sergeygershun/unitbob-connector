import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, type ProcResult } from '../proc.ts';
import { GUARDRAILS_DIR, HELPER_FILE } from '../files/guardrails.ts';
import { PROVISION_TIMEOUT_MS } from './provision.ts';

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
  | { status: 'not_checked'; reason: 'no_runner' | 'timed_out' | 'nothing_to_load' };

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
    runProcess(command, args, {
      cwd: options.cwd,
      timeoutMs: PROVISION_TIMEOUT_MS,
      env: { ...process.env, ...options.env },
    }),
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
    'Partial signal on this stack: collection only imports what the tests import, ' +
    'so code no test reaches was not checked.',
  vitest:
    'Weak signal on this stack: only test files are parsed and imported. Type errors are ' +
    'not checked at all (vite and esbuild strip types without checking them), and a project ' +
    'with no tests yields no signal.',
};

// Does the suite for this stack get off the ground? One attempt, one answer.
export async function bootCheck(
  projectRoot: string,
  runner: string | null,
  deps: BootCheckDeps = defaultDeps,
): Promise<BootCheck> {
  switch (runner) {
    case 'rspec':
      return rubyBootCheck(projectRoot, deps);
    case 'pytest':
      return pytestBootCheck(projectRoot, deps);
    case 'vitest':
      return vitestBootCheck(projectRoot, deps);
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
  const helper = join(projectRoot, GUARDRAILS_DIR, HELPER_FILE);
  if (!existsSync(helper)) return { status: 'not_checked', reason: 'nothing_to_load' };

  const first = await loadRubyHelper(projectRoot, helper, deps);
  if (first.status !== 'broken') return first;

  // Repair what we are allowed to repair, then ask once more. A vibecoder has
  // no test database — demanding one would turn away nearly every user we have.
  // Never in a loop: one attempt, one retry, then the answer stands.
  if (!(await prepareTestDatabase(projectRoot, deps))) return first;

  return loadRubyHelper(projectRoot, helper, deps);
}

async function loadRubyHelper(
  projectRoot: string,
  helper: string,
  deps: BootCheckDeps,
): Promise<BootCheck> {
  const localBundle = join(projectRoot, 'bin', 'bundle');
  const command = existsSync(localBundle) ? localBundle : 'bundle';

  return classify(
    projectRoot,
    'rspec',
    await attempt(deps, command, ['exec', 'ruby', '-e', `require ${JSON.stringify(helper)}`], {
      cwd: projectRoot,
      env: { RAILS_ENV: 'test', UNITBOB_REPO_ROOT: projectRoot },
    }),
    // A clean load says nothing on stdout and exits 0. Anything else is the
    // suite failing to start.
    (result) => (result.code === 0 ? 'ok' : 'broken'),
  );
}

// Python: `pytest --collect-only` imports every test module, which is what the
// run would do first. It sees import errors in code the tests reach, and only
// there — recorded as a limitation rather than dressed up as completeness.
async function pytestBootCheck(projectRoot: string, deps: BootCheckDeps): Promise<BootCheck> {
  for (const python of ['python3', 'python']) {
    const result = await attempt(deps, python, ['-m', 'pytest', '--collect-only', '-q'], {
      cwd: projectRoot,
    });
    if (result === null) continue; // this interpreter is not on the machine

    return classify(projectRoot, 'pytest', result, (proc) => {
      if (proc.code === 0) return 'ok';
      // Exit 5 is pytest for "collected nothing". Nothing to load is not the
      // same as broken, and a project that came to Unitbob *for* tests is the
      // typical customer, not a defect.
      if (proc.code === 5) return 'nothing_to_load';
      return 'broken';
    });
  }
  return { status: 'not_checked', reason: 'no_runner' };
}

// JS/TS: `vitest list` parses and imports the test files, which is the closest
// thing this stack has to a boot.
//
// `tsc --noEmit` is deliberately not used. It answers a different question —
// are the types sound — and a project with a hundred type errors runs perfectly
// well, because vite, esbuild and tsx strip types without checking them. Type
// errors accumulate for years in healthy codebases; calling that "broken" would
// turn away the majority. A file that is genuinely unparseable is caught here
// anyway, since `vitest list` has to parse it.
async function vitestBootCheck(projectRoot: string, deps: BootCheckDeps): Promise<BootCheck> {
  const local = join(projectRoot, 'node_modules', '.bin', 'vitest');
  // Only a vitest already installed in the project is used. Reaching for `npx`
  // would install a package to answer a question, and installing into the
  // user's project is not this check's business.
  if (!existsSync(local)) return { status: 'not_checked', reason: 'no_runner' };

  const result = await attempt(deps, local, ['list'], { cwd: projectRoot });
  return classify(projectRoot, 'vitest', result, (proc) => {
    if (proc.code === 0) return 'ok';
    if (/no test files found/i.test(`${proc.stdout}\n${proc.stderr}`)) return 'nothing_to_load';
    return 'broken';
  });
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

function classify(
  projectRoot: string,
  runner: string,
  result: ProcResult | null,
  verdict: (proc: ProcResult) => 'ok' | 'broken' | 'nothing_to_load',
): BootCheck {
  if (result === null) return { status: 'not_checked', reason: 'no_runner' };
  // runProcess reports a timeout as a null exit code. Waiting too long tells us
  // nothing about the code, so it must not read as a defect.
  if (result.code === null) return { status: 'not_checked', reason: 'timed_out' };

  const outcome = verdict(result);
  if (outcome === 'ok') return { status: 'ok' };
  if (outcome === 'nothing_to_load') return { status: 'not_checked', reason: 'nothing_to_load' };

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
  // A leading `/` counts: runners print these paths both relative to the
  // project and absolute, and both are the same frame. Over-matching a
  // dependency's own `app/` directory is harmless here, because the
  // dependency-missing test above has already had its say.
  const ownDirs = runner === 'vitest' ? ['src'] : ['app', 'lib'];
  for (const dir of ownDirs) {
    if (new RegExp(`(^|[\\s"'(\\[/])${dir}/`, 'm').test(output)) return true;
  }

  // Python has no fixed layout to name, so the project's own code is defined by
  // where it sits: inside the repository and outside the places dependencies
  // are installed into. That rule needs no list of package names and holds for
  // any layout.
  return output
    .split('\n')
    .some(
      (line) =>
        line.includes(projectRoot) &&
        !/site-packages|dist-packages|node_modules|[/.]venv\//.test(line),
    );
}

// The runner's own words, never a paraphrase. A vibecoder can search for this
// string; a summary of it they cannot. File and line come along when the runner
// put them on the same line, and are not manufactured when it did not.
function firstErrorLine(output: string): string {
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

  const rails = join(projectRoot, 'bin', 'rails');
  const command = existsSync(rails) ? rails : 'bundle';
  const args = existsSync(rails) ? ['db:test:prepare'] : ['exec', 'rails', 'db:test:prepare'];

  const result = await attempt(deps, command, args, {
    cwd: projectRoot,
    env: { RAILS_ENV: 'test', UNITBOB_REPO_ROOT: projectRoot },
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
