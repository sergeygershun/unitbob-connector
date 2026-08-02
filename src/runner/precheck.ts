import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Stack prechecks (spec 26, relaxed in spec 29, multi-language in spec 30).
// The host LLM chooses one primary stack during guardrail generation; the
// connector confirms that choice against local project markers before writing
// or uploading anything, so a wrong pick stops with one actionable message
// instead of a misleading result. We do not boot anything here — an app that
// cannot boot surfaces later as a suite error from the actual run.
export interface PrecheckResult {
  ok: boolean;
  message?: string;
}

// The one seam that shells out (pytest availability). Injected so tests stay
// deterministic regardless of what Python is installed on the machine.
export interface PrecheckDeps {
  commandSucceeds: (command: string, args: string[], cwd: string) => boolean;
}

const defaultDeps: PrecheckDeps = {
  commandSucceeds: (command, args, cwd) => spawnSync(command, args, { cwd, timeout: 10_000 }).status === 0,
};

const STACKS = 'Ruby on Rails + RSpec, JavaScript/TypeScript + Vitest, or Python + pytest';

// Tried in this order, so a project carrying markers for more than one stack
// resolves to the same runner on every run.
const STRUCTURAL_RUNNERS = ['rspec', 'vitest', 'pytest'];

// Which structural runner this project's markers select, or null when none do.
// The gate below walks the same list: "is any stack present" and "which one is
// it" must never be able to disagree.
export function detectStructuralRunner(projectRoot: string, deps: PrecheckDeps = defaultDeps): string | null {
  return STRUCTURAL_RUNNERS.find((runner) => validateStack(projectRoot, runner, deps).ok) ?? null;
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

// The generation-time gate: at least one supported stack must be present.
export function anyStackPrecheck(projectRoot: string, deps: PrecheckDeps = defaultDeps): PrecheckResult {
  if (detectStructuralRunner(projectRoot, deps) !== null) return { ok: true };

  return {
    ok: false,
    message: `Unitbob guardrails support ${STACKS} only. This project matches none of those stacks.`,
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
  const markers = ['pyproject.toml', 'requirements.txt', 'Pipfile'];
  if (!markers.some((name) => existsSync(join(projectRoot, name)))) {
    return {
      ok: false,
      message:
        'The behavioral (Gherkin) suite selected the Python stack, but this project has none of ' +
        `${markers.join(', ')} — it does not look like a Python project.`,
    };
  }

  const available = ['python3', 'python'].some((python) =>
    deps.commandSucceeds(python, ['-m', 'pytest', '--version'], projectRoot),
  );
  if (!available) {
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
  const markers = ['pyproject.toml', 'requirements.txt', 'Pipfile'];
  const found = markers.some((name) => existsSync(join(projectRoot, name)));
  if (!found) {
    return {
      ok: false,
      message:
        'The Python stack was selected, but this project has none of ' +
        `${markers.join(', ')} — it does not look like a Python project.`,
    };
  }
  // Spec 30 fails closed on runner availability: unlike marker files, pytest
  // must actually be importable in the current interpreter, or every run would
  // end as a "No module named pytest" suite error after files were written. We
  // probe the same interpreters the pytest runner tries, in the same order, so
  // the precheck and the run agree on whether pytest is runnable.
  const available = ['python3', 'python'].some((python) =>
    deps.commandSucceeds(python, ['-m', 'pytest', '--version'], projectRoot),
  );
  if (!available) {
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

function hasGemfileWith(projectRoot: string, pattern: RegExp): boolean {
  for (const name of ['Gemfile', 'gems.rb']) {
    const path = join(projectRoot, name);
    if (existsSync(path) && pattern.test(readFileSync(path, 'utf8'))) return true;
  }
  return false;
}
