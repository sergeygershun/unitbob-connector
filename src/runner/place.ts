// Where this project's own processes start (spec 36).
//
// A mature team's test environment does not live on the machine the connector
// was called on: the code is on the host, and the interpreter, the packages and
// the database are inside a container. So "run it here" stops being a fact and
// becomes a question, and this module is the one place that answers it.
//
// The invariant the whole spec is built on:
//
//     Files stay on the host. Processes run where the dependencies live.
//
// Everything the connector reads and writes — request packets, suite files, run
// reports — it reads and writes on the host with ordinary filesystem calls. Only
// the processes that need the project's own toolchain travel.
//
// Which processes those are is not decided here and is deliberately not decided
// by a mode, a flag, or a global. It is decided at each call site by which
// function it calls: `runInProject` for a command that needs the project's
// dependencies, `runProcess` for a tool the connector brought with it (graphify
// is installed on the vibecoder's machine and is nowhere to be found inside
// somebody else's image). The rule is visible in the call itself, so the next
// reader sees the boundary without reading this file.
//
// The place itself is a property of the *project*, not of the run: it is written
// in `.unitbob.json` at the project root. So this module works it out from the
// project root it is handed, and no caller sets it, passes it, or can forget to.
import { spawnSync } from 'node:child_process';
import { runProcess, type ProcResult } from '../proc.ts';

export type Place = { kind: 'local' };

// The place this project's processes run in.
//
// Read from the project on every call rather than resolved once into a module
// variable. A setter would be cheap and would introduce exactly the failure this
// spec exists to remove: a new verb forgets to call it, the connector quietly
// runs on the host, and nobody finds out.
export function placeOf(_projectRoot: string): Place {
  return { kind: 'local' };
}

// How this place is written down in `.unitbob/.place`, so a runner environment
// built by one place is never mistaken for one built by another.
export function placeId(place: Place): string {
  return place.kind;
}

// The project root as the place sees it.
//
// Exactly one value in the system has to know where the root is —
// `UNITBOB_REPO_ROOT`, which the generated Ruby joins `config/environment` onto.
// It is built from the place rather than rewritten from a host path, so on the
// local place it is byte for byte the path it has always been.
export async function projectRootAsSeenByThePlace(projectRoot: string): Promise<string> {
  return projectRoot;
}

// What actually got spawned, alongside the usual result. The wrapper (if there
// is one) belongs to the caller: the "ran:" line a person reads, and the command
// string that travels to the brain on a failure, have to show the command as it
// was executed. A hidden wrapper hands somebody a line that fails differently
// when they paste it.
export interface ProjectRun extends ProcResult {
  command: string;
  args: string[];
}

export interface ProjectRunOptions {
  // Environment *overrides* — the variables the connector is setting on purpose,
  // and nothing else. Not a finished environment: merging with `process.env`
  // happens inside the local place and only there, because a place that is not
  // this machine has an environment of its own that the host's must not
  // overwrite.
  env?: Record<string, string>;
  timeoutMs?: number;
}

// Run one of the project's own commands, in the project's own root.
//
// The working directory is always the project root, and that is the discipline
// that keeps host paths out of commands rather than a rule that rewrites them:
// with the root as the working directory, every argument a command needs can be
// relative, and a relative argument means the same thing in every place.
export async function runInProject(
  projectRoot: string,
  command: string,
  args: string[],
  options: ProjectRunOptions = {},
): Promise<ProjectRun> {
  const result = await runProcess(command, args, {
    cwd: projectRoot,
    timeoutMs: options.timeoutMs,
    env: { ...process.env, ...options.env },
  });
  return { ...result, command, args };
}

// "Can this be started at all?" — asked of the same place that will start it.
//
// Kept next to `runInProject` rather than left at its old call site, because a
// check that asks this machine while the run happens somewhere else is a check
// that predicts the wrong thing. It is the same reason `runnerAvailable` already
// asks the same interpreters, in the same order, that the run itself asks.
export function commandSucceedsInProject(projectRoot: string, command: string, args: string[]): boolean {
  return spawnSync(command, args, { cwd: projectRoot, timeout: 10_000, env: { ...process.env } }).status === 0;
}
