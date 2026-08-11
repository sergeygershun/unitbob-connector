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
      return rubyPrecheck(projectRoot);
    case 'vitest':
      return vitestPrecheck(projectRoot);
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

function rubyPrecheck(projectRoot: string): PrecheckResult {
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
  if (!hasGemfileWith(projectRoot, /\brspec-rails\b/)) {
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

function vitestPrecheck(projectRoot: string): PrecheckResult {
  const packageJson = join(projectRoot, 'package.json');
  if (!existsSync(packageJson)) {
    return {
      ok: false,
      message: 'The JavaScript/TypeScript stack was selected, but this project has no package.json.',
    };
  }

  const hasVitest =
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
