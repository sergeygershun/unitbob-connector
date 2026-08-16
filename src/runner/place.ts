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
import { readLocalExecContainer } from '../config.ts';
import { runProcess, type ProcResult } from '../proc.ts';
import { containerProjectRoot, dockerExec, dockerOwnFailure, type ContainerLookup } from './docker.ts';

export type Place = { kind: 'local' } | { kind: 'docker'; container: string };

// The place this project's processes run in.
//
// Read from the project on every call rather than resolved once into a module
// variable. A setter would be cheap and would introduce exactly the failure this
// spec exists to remove: a new verb forgets to call it, the connector quietly
// runs on the host, and nobody finds out.
export function placeOf(projectRoot: string): Place {
  const container = readLocalExecContainer(projectRoot);
  return container ? { kind: 'docker', container } : { kind: 'local' };
}

// How this place is written down in `.unitbob/.place`, so a runner environment
// built by one place is never mistaken for one built by another.
const DOCKER_MARK = 'docker:';

export function placeId(place: Place): string {
  return place.kind === 'docker' ? `${DOCKER_MARK}${place.container}` : 'local';
}

// The same mark in words, for the one message that has to name both the place an
// environment was built in and the place this run happens in. It lives beside
// `placeId` because a format written in one file and taken apart in another is a
// format that drifts.
export function describePlaceId(id: string): string {
  return id.startsWith(DOCKER_MARK) ? `the container \`${id.slice(DOCKER_MARK.length)}\`` : 'this machine';
}

// The project root as the place sees it.
//
// Exactly one value in the system has to know where the root is —
// `UNITBOB_REPO_ROOT`, which the generated Ruby joins `config/environment` onto.
// It is built from the place rather than rewritten from a host path, so on the
// local place it is byte for byte the path it has always been.
export function projectRootAsSeenByThePlace(projectRoot: string): string {
  const place = placeOf(projectRoot);
  if (place.kind === 'local') return projectRoot;

  const lookup = containerProjectRoot(place.container, projectRoot);
  if (lookup.status === 'ok') return lookup.projectRoot;

  // Every command that must not run blind has been through `placeProblem`
  // first. The one that has not is `map-prepare`, which asks the router and is
  // allowed to fail — it degrades to one line and the map is built from source
  // as it always was. So this returns something rather than throwing out of what
  // reads like a getter: the command it belongs to is not going to run anyway.
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
  const place = placeOf(projectRoot);
  if (place.kind === 'local') {
    const result = await runProcess(command, args, {
      cwd: projectRoot,
      timeoutMs: options.timeoutMs,
      env: { ...process.env, ...options.env },
    });
    return { ...result, command, args };
  }

  const shaped = shapeForContainer(place.container, projectRoot, command, args, options.env ?? {});
  const result = await runProcess(shaped.command, shaped.args, {
    cwd: projectRoot,
    timeoutMs: options.timeoutMs,
    // The environment of the `docker` client, not of the command: everything the
    // command is meant to see was listed with `-e` above. This machine's own
    // PATH and HOME never travel — a container has a PATH of its own, and
    // overwriting it hides the very `bundle` the image was built with.
    env: process.env,
  });

  const failure = dockerOwnFailure(result);
  return { ...result, ...(failure ? { placeFailure: failure } : {}), command: shaped.command, args: shaped.args };
}

function shapeForContainer(
  container: string,
  projectRoot: string,
  command: string,
  args: string[],
  env: Record<string, string>,
): { command: string; args: string[] } {
  const lookup = containerProjectRoot(container, projectRoot);
  // `/` is not a working directory anything would succeed in, and that is the
  // point: the lookup has already failed, every caller of consequence has been
  // through `ensurePlaceIsUsable`, and docker's own refusal is a better answer
  // than a path this connector made up.
  const workingDirectory = lookup.status === 'ok' ? lookup.projectRoot : '/';
  return dockerExec(container, workingDirectory, env, command, args);
}

// Can work happen here at all? Asked before anything is written and before
// anything is uploaded (spec 36, criterion 7), because the alternative is a
// green run whose evidence disappears with the container.
//
// Returns the sentence to stop with, or null when the place is usable. Not a
// throw: two callers want to stop, one — the map — wants to degrade quietly, and
// the difference belongs to them.
export function placeProblem(projectRoot: string): string | null {
  const place = placeOf(projectRoot);
  if (place.kind === 'local') return null;

  return explain(place.container, containerProjectRoot(place.container, projectRoot));
}

function explain(container: string, lookup: ContainerLookup): string | null {
  switch (lookup.status) {
    case 'ok':
      return null;
    case 'no_docker':
      return (
        `This project is set to run its tests inside the container \`${container}\`, but \`docker\` is not ` +
        'available on this machine — either it is not installed or its daemon is not running. Start Docker, ' +
        `or remove \`"exec"\` from ${CONFIG_HINT} to run everything here instead.`
      );
    case 'no_container':
      return (
        `This project is set to run its tests inside the container \`${container}\`, and no container of that ` +
        'name exists here. Check the name with `docker ps --format "{{.Names}}"` and correct it in ' +
        `${CONFIG_HINT}.`
      );
    case 'not_running':
      return (
        `The container \`${container}\` exists but is not running, and this project's tests are set to run ` +
        `inside it. Start it (\`docker start ${container}\`, or \`docker compose up -d\`), then run this again.`
      );
    case 'not_mounted':
      return (
        `The container \`${container}\` is running, but this project's folder is not mounted into it — the ` +
        'code inside it was copied in when the image was built. Unitbob cannot work that way: it writes the ' +
        'suite here and the run has to read it there, and a report written inside a container that is not ' +
        'sharing this folder disappears with the container. Mount the project into the container (a `volumes:` ' +
        'entry in your compose file) and run this again. Nothing was written and nothing was uploaded.'
      );
    case 'unreadable':
      return (
        `Could not ask docker about the container \`${container}\`, which is where this project's tests are ` +
        `set to run: ${lookup.detail}`
      );
  }
}

const CONFIG_HINT = '`.unitbob.json`';

// "Can this be started at all?" — asked of the same place that will start it.
//
// Kept next to `runInProject` rather than left at its old call site, because a
// check that asks this machine while the run happens somewhere else is a check
// that predicts the wrong thing. It is the same reason `runnerAvailable` already
// asks the same interpreters, in the same order, that the run itself asks.
// One known limitation, written down rather than hidden: the answer is a
// boolean, so a container that died between the preflight and this question
// comes back as "no, that cannot be started" — the same conflation `place_failed`
// was added to the boot check to stop making. It stays a boolean because every
// caller of `locateRunner` is synchronous and takes yes or no; what keeps it from
// being the ordinary case is `placeProblem`, which runs first for every command
// that would act on the answer.
export function commandSucceedsInProject(projectRoot: string, command: string, args: string[]): boolean {
  const place = placeOf(projectRoot);
  const shaped =
    place.kind === 'local'
      ? { command, args }
      : shapeForContainer(place.container, projectRoot, command, args, {});

  const result = spawnSync(shaped.command, shaped.args, {
    cwd: projectRoot,
    // A round trip through the docker daemon is not the same wait as starting a
    // local binary: the client has to reach the daemon, and the daemon has to
    // start a process in a container that may be busy running the application.
    // Ten seconds is right for `python3 -m pytest --version` here and is the
    // kind of budget that turns a slow machine into "no runner available".
    timeout: place.kind === 'local' ? 10_000 : 60_000,
    env: { ...process.env },
  });
  return result.status === 0;
}
