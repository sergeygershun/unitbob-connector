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

// The generation-time gate: at least one supported stack must be present.
export function anyStackPrecheck(projectRoot: string, deps: PrecheckDeps = defaultDeps): PrecheckResult {
  const supported = ['rspec', 'vitest', 'pytest'].some((runner) => validateStack(projectRoot, runner, deps).ok);
  if (supported) return { ok: true };

  return {
    ok: false,
    message: `Unitbob guardrails support ${STACKS} only. This project matches none of those stacks.`,
  };
}

// Confirm the host-selected runner against local markers. A mismatch fails
// closed: the caller writes no files and uploads nothing.
export function validateStack(projectRoot: string, runner: string, deps: PrecheckDeps = defaultDeps): PrecheckResult {
  switch (runner) {
    case 'rspec':
      return rubyPrecheck(projectRoot);
    case 'vitest':
      return vitestPrecheck(projectRoot);
    case 'pytest':
      return pytestPrecheck(projectRoot, deps);
    default:
      return {
        ok: false,
        message: `Unsupported runner "${runner}" — Unitbob supports rspec, vitest, and pytest only.`,
      };
  }
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
