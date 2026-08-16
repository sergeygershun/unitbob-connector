import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { executable } from '../proc.ts';
import { commandSucceedsInProject } from './place.ts';

// Where Unitbob keeps a test runner it had to install for itself, together with
// whatever that runner needs to load the project.
//
// Deliberately not `.unitbob/structural/`: `materializeGuardrails` deletes that
// directory before every suite write, so an environment installed there would be
// rebuilt on every single run. Deliberately not the project's own dependency
// files either — the whole point is that a vibecoder's repository looks exactly
// the same after Unitbob has run as it did before. `.unitbob/` is already in
// their .gitignore (see `ensureUnitbobIgnored`).
export const SIDECAR_DIR = '.unitbob/runners';

export function sidecarPath(projectRoot: string, ...segments: string[]): string {
  return join(projectRoot, SIDECAR_DIR, ...segments);
}

// The stop that means "nothing here can start this project's test runner"
// (spec 36, §7.1).
//
// It carries no new wording — the four places that throw it say exactly what
// they said before. All it adds is a name, so that one place at the top can tell
// this stop apart from "the server did not answer" and "your token was refused",
// and offer the one piece of advice that only fits this one. Hanging that advice
// on the individual failure sites instead would have given it to Ruby alone: a
// pytest project in a container stops somewhere else, with different words, and
// a vitest one somewhere else again.
export class ToolchainUnavailableError extends Error {
  readonly projectRoot: string;

  constructor(message: string, projectRoot: string) {
    super(message);
    this.name = 'ToolchainUnavailableError';
    this.projectRoot = projectRoot;
  }
}

// The file a command names, on the host's own filesystem.
//
// A command that names a file we own is written relative to the project root, so
// that it means the same thing wherever it is started (spec 36, §4.2). Asking
// whether that file exists is a different question and is always the host's:
// under the invariant the connector's files are on the host, and the place sees
// the very same ones. A command with no path in it — `bundle`, `python3` — is
// resolved by the place through its own PATH and is returned unchanged.
export function commandFileOnHost(projectRoot: string, command: string): string {
  if (isAbsolute(command) || !command.includes('/')) return command;
  return join(projectRoot, command);
}

// How to start one structural runner here, and where it came from.
//
// `args` is a prefix: the caller appends the runner's own arguments to it. That
// keeps `python -m pytest` and a bare `pytest` binary interchangeable at the one
// call site that cares.
export interface RunnerCommand {
  // Relative to the project root when it names a file (the working directory of
  // every project command is the project root), or a bare name to be found on
  // PATH. Never an absolute host path: see `commandFileOnHost`.
  command: string;
  args: string[];
  env?: Record<string, string>;
  // 'project' — the project's own installation, used as it stands.
  // 'sidecar'  — the one Unitbob installed under `.unitbob/runners/`.
  source: 'project' | 'sidecar';
}

// The one seam that shells out: "can this machine run this?" Injected so tests
// stay deterministic regardless of what happens to be installed on the machine
// running them.
export interface ToolDeps {
  commandSucceeds: (command: string, args: string[], cwd: string) => boolean;
}

// Asked of the place the run will happen in, never of this machine by default
// (spec 36, §3). `cwd` is the project root at every call site, which is what
// says which place that is.
export const defaultToolDeps: ToolDeps = {
  commandSucceeds: (command, args, cwd) => commandSucceedsInProject(cwd, command, args),
};

// How to invoke `runner` in this project, or null when nothing here can.
//
// The sidecar wins when it exists, and that order is deliberate. A sidecar is
// only ever built because the project could not supply the runner itself, so
// preferring it keeps every later run on the same environment the build was
// prepared against. The alternative — asking the project first, every time —
// lets a stray `pip install pytest` between two runs move the suite to a
// different interpreter without anybody choosing that, and a guardrail suite
// whose meaning is "green means fine" cannot afford a silent environment flip.
export function locateRunner(
  projectRoot: string,
  runner: string,
  deps: ToolDeps = defaultToolDeps,
): RunnerCommand | null {
  switch (runner) {
    case 'pytest':
      return locatePytest(projectRoot, deps);
    case 'vitest':
      return locateVitest(projectRoot);
    case 'rspec':
      return locateRspec(projectRoot);
    default:
      return null;
  }
}

// Is a runner available at all — from the project or from a sidecar?
export function runnerAvailable(projectRoot: string, runner: string, deps: ToolDeps = defaultToolDeps): boolean {
  return locateRunner(projectRoot, runner, deps) !== null;
}

// Does the project supply this runner on its own, with no help from us? This is
// the question provisioning asks before it builds anything: a project that is
// already set up is left completely alone.
//
// Ruby answers from the Gemfile rather than from `locateRspec`, which always has
// a `bundle exec rspec` to offer whether or not the gem behind it exists.
export function projectProvidesRunner(
  projectRoot: string,
  runner: string,
  deps: ToolDeps = defaultToolDeps,
): boolean {
  if (runner === 'rspec') {
    return hasGemfileWith(projectRoot, /\brails\b/) && hasGemfileWith(projectRoot, /\brspec-rails\b/);
  }
  return locateRunner(projectRoot, runner, deps)?.source === 'project';
}

// Does one of the project's Gemfiles mention this? Shared by the Ruby precheck
// and by the question above, so "is this a Rails project" is answered the same
// way wherever it is asked.
export function hasGemfileWith(projectRoot: string, pattern: RegExp): boolean {
  for (const name of ['Gemfile', 'gems.rb']) {
    const path = join(projectRoot, name);
    if (existsSync(path) && pattern.test(readFileSync(path, 'utf8'))) return true;
  }
  return false;
}

// Python: an interpreter that can actually import pytest. The sidecar venv is
// checked by file, the project's interpreters by asking them — `python3 -m
// pytest --version` is the same question the run itself asks, so the two can
// never disagree about which interpreter is usable.
function locatePytest(projectRoot: string, deps: ToolDeps): RunnerCommand | null {
  // The sidecar interpreter is asked the same question as any other, rather
  // than trusted because the file is there. A virtualenv can exist and still
  // have no pytest in it — `uv venv` creates one with no pip at all, so an
  // install into it can fail while leaving a perfectly good `bin/python`
  // behind. Trusting the file made provisioning report success and the boot
  // check then say "No module named pytest" about an environment we had just
  // built. Found on a Flask project, 2026-08-12.
  const venvPython = `${SIDECAR_DIR}/.venv/bin/python`;
  if (
    executable(commandFileOnHost(projectRoot, venvPython)) &&
    deps.commandSucceeds(venvPython, ['-m', 'pytest', '--version'], projectRoot)
  ) {
    return { command: venvPython, args: ['-m', 'pytest'], source: 'sidecar' };
  }

  for (const python of ['python3', 'python']) {
    if (deps.commandSucceeds(python, ['-m', 'pytest', '--version'], projectRoot)) {
      return { command: python, args: ['-m', 'pytest'], source: 'project' };
    }
  }
  return null;
}

// JS/TS: a vitest binary we can spawn. `npx` is not offered here — it would
// install a package to answer a question, and this function's callers include
// checks that must not install anything. The vitest runner keeps `npx` as its
// own last resort, which is the behaviour it has always had.
function locateVitest(projectRoot: string): RunnerCommand | null {
  const sidecar = `${SIDECAR_DIR}/node_modules/.bin/vitest`;
  if (executable(commandFileOnHost(projectRoot, sidecar))) return { command: sidecar, args: [], source: 'sidecar' };

  const project = 'node_modules/.bin/vitest';
  if (executable(commandFileOnHost(projectRoot, project))) return { command: project, args: [], source: 'project' };

  return null;
}

// Ruby: bundler decides what "rspec" means, so the sidecar is selected by
// pointing BUNDLE_GEMFILE at the sidecar Gemfile rather than by a different
// binary. The project's own `bin/rspec` binstub is preferred over `bundle exec`
// when it is there, exactly as the rspec runner has always preferred it.
function locateRspec(projectRoot: string): RunnerCommand | null {
  if (existsSync(sidecarPath(projectRoot, 'Gemfile'))) {
    return {
      command: 'bundle',
      args: ['exec', 'rspec'],
      env: { BUNDLE_GEMFILE: `${SIDECAR_DIR}/Gemfile` },
      source: 'sidecar',
    };
  }

  // Relative, and the slash is not decoration: `spawn` resolves a command
  // against the working directory only when it has one, and a bare `rspec` would
  // go looking on PATH — a different command altogether.
  const binstub = 'bin/rspec';
  if (executable(commandFileOnHost(projectRoot, binstub))) return { command: binstub, args: [], source: 'project' };

  return { command: 'bundle', args: ['exec', 'rspec'], source: 'project' };
}
