import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultToolDeps,
  hasGemfileWith,
  locateRunner,
  projectProvidesRunner,
  runnerAvailable,
  SIDECAR_DIR,
  type ToolDeps,
} from './toolchain.ts';

// Stack prechecks (spec 26, relaxed in spec 29, multi-language in spec 30).
// The host LLM chooses one primary stack during guardrail generation; the
// connector confirms that choice against local project markers before writing
// or uploading anything, so a wrong pick stops with one actionable message
// instead of a misleading result. We do not boot anything here — an app that
// cannot boot surfaces later as a suite error from the actual run.
export interface PrecheckResult {
  ok: boolean;
  message?: string;
  // Which structural runner the markers selected, when they selected one. The
  // gate has to work this out to answer at all, so it hands it back rather than
  // making the caller ask again — on Python that second ask shells out to
  // `python -m pytest --version` a second time.
  runner?: string;
}

// The one seam that shells out (pytest availability). Injected so tests stay
// deterministic regardless of what Python is installed on the machine. The
// definition itself now lives in `toolchain.ts`, with the code that spawns.
export type PrecheckDeps = ToolDeps;

const defaultDeps: PrecheckDeps = defaultToolDeps;

const STACKS = 'Ruby on Rails + RSpec, JavaScript/TypeScript + Vitest, or Python + pytest';

// Tried in this order, so a project carrying markers for more than one stack
// resolves to the same runner on every run.
const STRUCTURAL_RUNNERS = ['rspec', 'vitest', 'pytest'];

// The file that says "this project is written in this language". Nothing here
// asks whether the runner is installed — that is a separate question with a
// separate answer, and merging the two is what made this gate lie.
//
// A project whose language is obvious but whose runner is missing used to fail
// detection, and the caller then reported the only thing it had left: "this
// project matches none of those stacks". That sentence was false — the project
// was Python, it simply had no pytest — and it sent people to look for a problem
// with their project instead of at the one command that fixes it. The runner is
// now provisioned under `.unitbob/` (see `ensureStructuralRunner`), so the
// question this gate answers is the one it can answer honestly: which language.
const PYTHON_MARKERS = ['pyproject.toml', 'requirements.txt', 'Pipfile'];

function looksLikePython(projectRoot: string): boolean {
  return PYTHON_MARKERS.some((name) => existsSync(join(projectRoot, name)));
}

const STACK_MARKERS: Record<string, (projectRoot: string) => boolean> = {
  rspec: (projectRoot) => hasGemfileWith(projectRoot, /\brails\b/),
  vitest: (projectRoot) => existsSync(join(projectRoot, 'package.json')),
  pytest: looksLikePython,
};

// Which structural runner this project's markers select, or null when none do.
// The gate below walks the same list: "is any stack present" and "which one is
// it" must never be able to disagree.
export function detectStructuralRunner(projectRoot: string, _deps: PrecheckDeps = defaultDeps): string | null {
  return STRUCTURAL_RUNNERS.find((runner) => STACK_MARKERS[runner]?.(projectRoot)) ?? null;
}

// The BDD runner for a structural stack. One project, one language: the
// behavioral peer follows the stack already detected instead of probing the
// filesystem a second time.
//
// A second probe used to answer first on `package.json` alone, so a Rails app
// with any front-end build — the common case — got an rspec structural branch
// and a cucumber-js behavioral one. Step definitions in JavaScript cannot boot
// Rails, use its test helpers, or reach its test database, so that branch was
// dead before it was written, and the generation recipe allows exactly one stack
// per project anyway.
const BDD_RUNNER_FOR_STACK: Record<string, string> = {
  rspec: 'cucumber',
  vitest: 'cucumber-js',
  pytest: 'pytest-bdd',
};

export function detectBddRunner(projectRoot: string, deps: PrecheckDeps = defaultDeps): string | null {
  const structural = detectStructuralRunner(projectRoot, deps);
  return structural ? BDD_RUNNER_FOR_STACK[structural] ?? null : null;
}

// The generation-time gate: at least one supported stack must be present. It
// says nothing about whether the runner is installed, because by the time that
// matters the runner has been provisioned; `runnerReadyPrecheck` is the check
// for that, and it runs straight after provisioning.
export function anyStackPrecheck(projectRoot: string, deps: PrecheckDeps = defaultDeps): PrecheckResult {
  const runner = detectStructuralRunner(projectRoot, deps);
  if (runner !== null) return { ok: true, runner };

  return {
    ok: false,
    message: `Unitbob guardrails support ${STACKS} only. This project matches none of those stacks.`,
  };
}

// Is the runner startable now, after provisioning has had its turn?
//
// Not the same question as `validateStack`, and the difference is the sidecar.
// `validateStack` asks whether the *project* is set up for a stack — the right
// question when a host has chosen one and nothing has been installed yet. This
// asks whether anything on this machine can start the runner, which includes
// the environment Unitbob just built under `.unitbob/`.
//
// Asking the first question in the second's place refuses a project we have
// only just finished preparing: a JS project with no vitest of its own was
// told to `npm i -D vitest` seconds after a working vitest was installed for
// it. Found on the connector's own repository, 2026-08-12.
export function runnerReadyPrecheck(
  projectRoot: string,
  runner: string,
  deps: PrecheckDeps = defaultDeps,
): PrecheckResult {
  // Ruby is the one stack whose lookup can never come back empty — `bundle exec
  // rspec` is always a command one could type — so readiness is the gem being
  // resolvable, from the sidecar Gemfile or from the project's own.
  const ready =
    runner === 'rspec'
      ? locateRunner(projectRoot, 'rspec')?.source === 'sidecar' || projectProvidesRunner(projectRoot, 'rspec', deps)
      : runnerAvailable(projectRoot, runner, deps);

  if (ready) return { ok: true };

  return {
    ok: false,
    message:
      `The ${runner} runner is not available: it is not installed in this project, and Unitbob could ` +
      `not install one for itself under ${SIDECAR_DIR}/. Nothing was written and nothing was uploaded.`,
  };
}

// Has Unitbob built this runner for this project already? One question, asked
// the same way by every precheck that would otherwise advise the user to install
// something they now have.
//
// Ruby needs the second half. Its sidecar is a Gemfile, and `provisionRspec`
// writes that file *before* it runs bundler and leaves it in place when bundler
// fails — so its mere existence says "we tried", not "it is there", and taking
// it as proof would silence the rspec-rails advice exactly when the install
// failed and the advice is what the user needs. Bundler rewrites the sidecar
// lock on success, and the project's own lock cannot name a gem its Gemfile
// lacks, so the gem appearing there is the first artefact that means it
// resolves. The vitest side needs nothing extra: `locateVitest` tests the actual
// `.bin/vitest` executable.
function sidecarProvides(projectRoot: string, runner: string, deps: PrecheckDeps = defaultDeps): boolean {
  if (locateRunner(projectRoot, runner, deps)?.source !== 'sidecar') return false;
  if (runner !== 'rspec') return true;

  const lock = join(projectRoot, SIDECAR_DIR, 'Gemfile.lock');
  return existsSync(lock) && /\brspec-rails\s+\(/.test(readFileSync(lock, 'utf8'));
}

// Confirm the host-selected runner against local markers. A mismatch fails
// closed: the caller writes no files and uploads nothing.
//
// Both contract systems route through here (spec 32). The structural runners
// (rspec/vitest/pytest) confirm the exact test framework is present, because the
// host writes and runs against it. The behavioral BDD runners
// (cucumber/cucumber-js/pytest-bdd) confirm only the base language: `check` never
// installs anything, so a missing BDD runner is left to surface as a suite error
// from the actual run — the precheck just replaces "bundle: command not found"
// with an early, clear "this project isn't Ruby".
export function validateStack(projectRoot: string, runner: string, deps: PrecheckDeps = defaultDeps): PrecheckResult {
  switch (runner) {
    case 'rspec':
      return rubyPrecheck(projectRoot, deps);
    case 'vitest':
      return vitestPrecheck(projectRoot, deps);
    case 'pytest':
      return pytestPrecheck(projectRoot, deps);
    case 'cucumber':
      return rubyBehavioralPrecheck(projectRoot);
    case 'cucumber-js':
      return jsBehavioralPrecheck(projectRoot);
    case 'pytest-bdd':
      return pythonBehavioralPrecheck(projectRoot, deps);
    default:
      return {
        ok: false,
        message: `Unsupported runner "${runner}" — Unitbob supports ` +
          'rspec, vitest, pytest, cucumber, cucumber-js, and pytest-bdd only.',
      };
  }
}

// The behavioral suite boots the app in its test environment, so a Ruby project
// is the marker — but not rspec-rails (the behavioral runner is cucumber, not
// rspec), and not the cucumber gem itself (check never installs; a missing
// runner surfaces as a suite error from the run).
function rubyBehavioralPrecheck(projectRoot: string): PrecheckResult {
  if (hasGemfileWith(projectRoot, /\brails\b/)) return { ok: true };

  return {
    ok: false,
    message:
      'The behavioral (Gherkin) suite selected the Ruby stack, but this project does not look ' +
      'like Rails (no `rails` gem found in Gemfile).',
  };
}

// What the behavioral branch's environment is, before a single step is written
// (spec 35-1, criterion 2). None of the three BDD runners reads the project's own
// test bootstrap, so on every stack nothing a project's test setup switches on is
// on here — and a worker who assumes otherwise writes a test that quietly goes
// out to the real network.
//
// One sentence per runner, in that runner's own terms and stating only what is
// true of it. A shared sentence would have to be vague enough to fit all three,
// and vague is how the fact went unsaid in the first place.
const BEHAVIORAL_HARNESS_NOTICE: Readonly<Record<string, string>> = {
  cucumber:
    'Cucumber loads neither `spec/rails_helper.rb` nor `spec/support/**` — whatever your RSpec ' +
    'setup switches on is off here. The connector-owned World file turns on the part that is the ' +
    'same in every Rails app: WebMock is on and outgoing HTTP is blocked (localhost still ' +
    'reachable), Sidekiq is in fake mode, ActiveJob is on the test adapter, and the default URL ' +
    'host is fixed. Everything that depends on this application — signing in, factories, reading ' +
    'props, stubbing a provider — is yours to write in shared steps.',

  'cucumber-js':
    'cucumber-js loads none of this project\'s test bootstrap — not your Vitest setup files, and ' +
    'not `features/support/`, which the connector\'s explicit `--require` switches off. Whatever ' +
    'your test setup switches on is off here. The connector-owned World file settles the one ' +
    'thing that is the same in every JavaScript project: a connection that would leave this ' +
    'machine is refused, localhost included in neither direction — it stays reachable. There is ' +
    'no project-wide job runner or default host to fix, so nothing else is assumed. Signing in, ' +
    'fixtures and seeding are yours to write in shared steps.',

  'pytest-bdd':
    'pytest runs here against the connector\'s own config (`-c`), so this project\'s pytest ' +
    'settings — addopts, markers, plugin configuration — do not apply, and the only conftest.py ' +
    'files loaded are those from the repository root down to `step_definitions/`: your ' +
    '`tests/conftest.py` fixtures are not available. The connector-owned `conftest.py` one level ' +
    'above `step_definitions/` settles the one thing that is the same in every Python project: a ' +
    'connection that would leave this machine is refused, and localhost stays reachable. Your own ' +
    '`step_definitions/conftest.py` is untouched and is where your shared fixtures belong.',
};

export function behavioralHarnessNotice(runner: string): string | null {
  const notice = BEHAVIORAL_HARNESS_NOTICE[runner];
  return notice ? `\n${notice}\n` : null;
}

function jsBehavioralPrecheck(projectRoot: string): PrecheckResult {
  if (existsSync(join(projectRoot, 'package.json'))) return { ok: true };

  return {
    ok: false,
    message: 'The behavioral (Gherkin) suite selected the JavaScript/TypeScript stack, but this project has no package.json.',
  };
}

// pytest-bdd runs under pytest, so the harness must be importable — same probe
// and message shape as the structural pytest precheck; pytest-bdd itself, if
// missing, surfaces as a suite error from the run.
function pythonBehavioralPrecheck(projectRoot: string, deps: PrecheckDeps): PrecheckResult {
  if (!looksLikePython(projectRoot)) {
    return {
      ok: false,
      message:
        'The behavioral (Gherkin) suite selected the Python stack, but this project has none of ' +
        `${PYTHON_MARKERS.join(', ')} — it does not look like a Python project.`,
    };
  }

  if (!runnerAvailable(projectRoot, 'pytest', deps)) {
    return {
      ok: false,
      message:
        'The behavioral (Gherkin) suite selected the Python stack, but pytest is not importable in ' +
        'the current Python environment. If your dependencies live in a virtualenv, activate it ' +
        '(e.g. `source .venv/bin/activate`) before running Unitbob, then retry.',
    };
  }
  return { ok: true };
}

function rubyPrecheck(projectRoot: string, deps: PrecheckDeps): PrecheckResult {
  if (!hasGemfileWith(projectRoot, /\brails\b/)) {
    return {
      ok: false,
      message:
        'The Ruby stack was selected, but this project does not look like Rails ' +
        '(no `rails` gem found in Gemfile).',
    };
  }
  // Specifically rspec-rails: the boot helper requires `rspec/rails`, so a
  // bare `rspec` gem passes nothing downstream — stop with the honest offer.
  //
  // Unless Unitbob already installed one for itself. The advice below asks the
  // user to change their Gemfile, and that is the wrong sentence seconds after a
  // working runner was provisioned under `.unitbob/`. `runnerReadyPrecheck`
  // already knows this; this function used to send the reader back to the old
  // answer regardless.
  if (!sidecarProvides(projectRoot, 'rspec', deps) && !hasGemfileWith(projectRoot, /\brspec-rails\b/)) {
    return {
      ok: false,
      message:
        "Unitbob guardrails need the rspec-rails gem, which is not in this project's " +
        'Gemfile. Offer the user to add it and run `bundle install`; change the Gemfile ' +
        'only with their consent, then retry.',
    };
  }
  return { ok: true };
}

function vitestPrecheck(projectRoot: string, deps: PrecheckDeps): PrecheckResult {
  const packageJson = join(projectRoot, 'package.json');
  if (!existsSync(packageJson)) {
    return {
      ok: false,
      message: 'The JavaScript/TypeScript stack was selected, but this project has no package.json.',
    };
  }

  // Same rule as the Ruby precheck above: a runner Unitbob installed for this
  // project is a runner this project has. Without this the connector's own
  // repository was told to `npm i -D vitest` seconds after a working vitest had
  // been put under `.unitbob/` for it.
  const hasVitest =
    sidecarProvides(projectRoot, 'vitest', deps) ||
    /"vitest"/.test(readFileSync(packageJson, 'utf8')) ||
    existsSync(join(projectRoot, 'node_modules', '.bin', 'vitest'));
  if (!hasVitest) {
    return {
      ok: false,
      message:
        'JS/TS guardrails require Vitest (Jest is not supported in MVP v2), and vitest was not ' +
        "found in this project's package.json or node_modules. Offer the user to add it " +
        '(`npm i -D vitest`); change dependencies only with their consent, then retry.',
    };
  }
  return { ok: true };
}

function pytestPrecheck(projectRoot: string, deps: PrecheckDeps): PrecheckResult {
  if (!looksLikePython(projectRoot)) {
    return {
      ok: false,
      message:
        'The Python stack was selected, but this project has none of ' +
        `${PYTHON_MARKERS.join(', ')} — it does not look like a Python project.`,
    };
  }
  // Spec 30 fails closed on runner availability: unlike marker files, pytest
  // must actually be importable, or every run would end as a "No module named
  // pytest" suite error after files were written. `runnerAvailable` asks the
  // same question the run asks, of the same environments in the same order —
  // the sidecar under `.unitbob/` first, then the machine's own interpreters —
  // so the check and the run can never disagree about what is runnable.
  if (!runnerAvailable(projectRoot, 'pytest', deps)) {
    return {
      ok: false,
      message:
        'The Python stack was selected, but pytest is not importable in the current Python ' +
        'environment. If your dependencies live in a virtualenv, activate it (e.g. ' +
        '`source .venv/bin/activate`) before running Unitbob; otherwise install pytest ' +
        '(`pip install pytest`), then retry.',
    };
  }
  return { ok: true };
}
