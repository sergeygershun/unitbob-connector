import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Pick the runner envelope this machine's stack selects, out of the ones the
// server sent with the assignment, and stamp it with the version actually
// installed here.
//
// The host used to compose this envelope itself, from a recipe that showed only
// its shape. It carries no judgement — the server owns which combinations are
// valid, and the connector owns the runner strategies they name and provisions
// them — yet one wrong field is rejected at upload, after the suite has been
// written, run, and reviewed. So the two sides that actually know each half fill
// it in, and the host copies it.
//
// The valid combinations are deliberately not duplicated here. They live in the
// server models that validate them, ride down in the packet, and are matched by
// the one field the connector genuinely owns: the `runner` strategy name it will
// execute (see `runner/bdd.ts` and the structural runners next to it).

export interface RunnerEnvelope {
  runner?: unknown;
  [key: string]: unknown;
}

export function selectRunnerEnvelope(
  candidates: unknown,
  runner: string | undefined,
): RunnerEnvelope | null {
  if (!runner || !Array.isArray(candidates)) return null;

  const match = candidates.find(
    (entry) => entry && typeof entry === 'object' && (entry as RunnerEnvelope).runner === runner,
  );
  return match ? { ...(match as RunnerEnvelope) } : null;
}

// The behavioral envelope also carries the pinned dependency actually installed
// into the isolated runner environment. Only the machine that provisioned the
// sidecar can know it, so it is read back from that environment rather than
// guessed.
//
// Unreadable means no envelope at all — never a partial one, and never an
// invented version. The server requires this field on every behavioral upload,
// so an envelope missing it is rejected at the last step, after the suite has
// been written, run, and reviewed: precisely the failure this whole path exists
// to remove. An envelope is either complete and copied verbatim, or absent and
// the branch does not get built.
export function withInstalledRunnerVersion(
  envelope: RunnerEnvelope,
  runner: string,
  projectRoot: string,
): RunnerEnvelope | null {
  const version = installedRunnerVersion(runner, projectRoot);
  return version ? { ...envelope, runner_version: version } : null;
}

const BEHAVIORAL_DIR = '.unitbob/behavioral';

// Matches the server's own PINNED_VERSION: a digit, then version characters.
const PINNED_VERSION = /^[0-9][0-9A-Za-z.\-+]*$/;

function installedRunnerVersion(runner: string, projectRoot: string): string | null {
  const root = join(projectRoot, BEHAVIORAL_DIR);
  const found = readInstalledVersion(runner, root);
  return found && PINNED_VERSION.test(found) ? found : null;
}

function readInstalledVersion(runner: string, root: string): string | null {
  switch (runner) {
    case 'cucumber':
      return gemfileLockVersion(join(root, 'Gemfile.lock'), 'cucumber');
    case 'cucumber-js':
      return packageJsonVersion(join(root, 'node_modules', '@cucumber', 'cucumber', 'package.json'));
    case 'pytest-bdd':
      return sitePackagesVersion(join(root, '.venv'), 'pytest_bdd');
    default:
      return null;
  }
}

// `    cucumber (9.2.0)` under GEM/specs. The indented, parenthesised form is
// the resolved version; the Gemfile's own `~> 9.0` constraint is not.
function gemfileLockVersion(path: string, gem: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const match = readFileSync(path, 'utf8').match(new RegExp(`^\\s{4}${gem} \\(([^)]+)\\)$`, 'm'));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function packageJsonVersion(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

// Installed distributions record their version in the `<name>-<version>.dist-info`
// directory name, which needs no interpreter to read.
function sitePackagesVersion(venv: string, distribution: string): string | null {
  try {
    for (const lib of readdirSync(join(venv, 'lib'))) {
      const packages = join(venv, 'lib', lib, 'site-packages');
      if (!existsSync(packages)) continue;

      for (const entry of readdirSync(packages)) {
        const match = entry.match(new RegExp(`^${distribution}-(.+)\\.dist-info$`));
        if (match) return match[1];
      }
    }
  } catch {
    return null;
  }
  return null;
}
