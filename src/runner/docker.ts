// Everything this connector knows about Docker, in one file (spec 36).
//
// It is deliberately not "a command prefix the user configures". A prefix would
// be three lines and would make every message below impossible: with only a
// string to run, nothing can say "that container is not running", "the project
// is not mounted into it", or "here is the container that already has your
// project". Those sentences are the point of the spec, so the connector knows
// what a container is.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { posix, relative, sep } from 'node:path';
import type { ProcResult } from '../proc.ts';

// What we can learn about a named container, in the vibecoder's terms. Each
// answer below has a different fix, so they are never merged into one vague
// "the runner is unavailable".
export type ContainerLookup =
  | { status: 'ok'; projectRoot: string }
  | { status: 'no_docker' }
  | { status: 'no_container' }
  | { status: 'not_running' }
  | { status: 'not_mounted' }
  | { status: 'unreadable'; detail: string };

interface Mount {
  Source?: string;
  Destination?: string;
}

interface Container {
  State?: { Running?: boolean };
  Mounts?: Mount[];
}

// Asked once per container per process. A single run asks where the project
// lives dozens of times — every provision step, every check, every run — and
// `docker inspect` is a round trip to the daemon each time.
const inspected = new Map<string, Container>();

// Where this container sees the project root, or why it cannot.
//
// The path inside is never configured. It is derived from the container's own
// mounts: the deepest mount whose source is the start of the path to the project
// root, with the remainder appended to its destination. Exact equality (`.:/app`)
// is the common case but not the only one — a monorepo mounts the parent
// (`..:/workspace`) and the project sits inside it, and demanding equality would
// report "your code is copied into the image" about a project that is plainly
// mounted.
//
// This doubles as the bind-mount check the whole invariant rests on: no mount
// covering the root means the code was copied into the image, which means files
// written here are invisible there and reports written there are invisible here.
export function containerProjectRoot(container: string, projectRoot: string): ContainerLookup {
  const cached = inspected.get(container);
  const found = cached ? { container: cached } : inspect(container);
  if ('failure' in found) return found.failure;
  inspected.set(container, found.container);

  if (found.container.State?.Running === false) return { status: 'not_running' };

  const mounted = mountedRoot(found.container.Mounts ?? [], projectRoot);
  return mounted === null ? { status: 'not_mounted' } : { status: 'ok', projectRoot: mounted };
}

function inspect(container: string): { container: Container } | { failure: ContainerLookup } {
  const result = spawnSync('docker', ['container', 'inspect', container, '--format', '{{json .}}'], {
    timeout: 30_000,
    encoding: 'utf8',
  });

  // `docker` is not on this machine at all — a different sentence from any
  // answer about the container, and the only one whose fix is "install Docker".
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') return { failure: { status: 'no_docker' } };
  if (result.error) return { failure: { status: 'unreadable', detail: result.error.message } };

  const stderr = (result.stderr ?? '').trim();
  if (result.status !== 0) {
    if (/no such (container|object)/i.test(stderr)) return { failure: { status: 'no_container' } };
    if (/cannot connect to the docker daemon/i.test(stderr)) return { failure: { status: 'no_docker' } };
    return { failure: { status: 'unreadable', detail: stderr || `docker inspect exited ${result.status}` } };
  }

  try {
    return { container: JSON.parse(result.stdout) as Container };
  } catch (err) {
    return { failure: { status: 'unreadable', detail: `could not read what docker said (${(err as Error).message})` } };
  }
}

// The deepest mount that holds this project, translated to the path inside.
//
// Both sides are resolved through their symlinks before they are compared. On
// macOS `/tmp` is a link to `/private/tmp`, so a project checked out under one
// and mounted as the other is the classic way to be told "there is no mount"
// where there plainly is one.
function mountedRoot(mounts: Mount[], projectRoot: string): string | null {
  const root = resolved(projectRoot);
  let best: { depth: number; path: string } | null = null;

  for (const mount of mounts) {
    if (!mount.Source || !mount.Destination) continue;

    const inside = relative(resolved(mount.Source), root);
    // Outside this mount, or on the far side of a `..`, or an absolute path
    // (which `relative` returns when the two share no root at all).
    if (inside.startsWith('..') || inside.startsWith('/')) continue;

    const depth = resolved(mount.Source).split(sep).length;
    if (best && best.depth >= depth) continue;

    // The container's own filesystem, so its own separator: a Windows host
    // still mounts into a Linux path.
    best = { depth, path: inside === '' ? mount.Destination : posix.join(mount.Destination, inside.split(sep).join('/')) };
  }

  return best?.path ?? null;
}

function resolved(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

// The command as it is actually executed. The wrapper is not hidden from
// anybody: the "ran:" line a person reads and the command string that travels to
// the brain on a failure both show this, because a line that quietly drops the
// wrapper is a line that fails differently when somebody pastes it.
export function dockerExec(
  container: string,
  workingDirectory: string,
  env: Record<string, string>,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  const variables = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return { command: 'docker', args: ['exec', '-w', workingDirectory, ...variables, container, command, ...args] };
}

// Docker's own failures, told apart from the project's.
//
// `docker exec` returns 125, 126 and 127 for reasons entirely its own — the
// container stopped between the check and the spawn, the executable is not in
// the image — and those codes collide with real runners' codes. Left
// unmarked, a boot check reads the exit code as "broken", picks a cause by
// matching the output against a path pattern, and can announce that it "found a
// defect that stops your test suite from starting". That would be an accusation
// about somebody's code for a failure of the daemon.
//
// So the code alone is never enough: the client has to have said something only
// it says.
const DOCKER_SPEAKING = /Error response from daemon|is not running|No such container|OCI runtime exec failed|executable file not found/i;

export function dockerOwnFailure(result: ProcResult): string | null {
  if (result.code !== 125 && result.code !== 126 && result.code !== 127) return null;
  return DOCKER_SPEAKING.test(result.stderr) ? result.stderr.trim() : null;
}

// Every running container that already holds this project, for the message
// somebody gets when their toolchain is nowhere to be found on this machine.
//
// Only ever called once a command has decided to fail. On the successful path
// `docker` is not run at all, so a project with no Docker in sight pays nothing
// and is asked nothing.
export function containersHolding(projectRoot: string): { name: string; projectRoot: string }[] {
  const listed = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { timeout: 30_000, encoding: 'utf8' });
  if (listed.error || listed.status !== 0) return [];

  const found: { name: string; projectRoot: string }[] = [];
  for (const name of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const lookup = containerProjectRoot(name, projectRoot);
    if (lookup.status === 'ok') found.push({ name, projectRoot: lookup.projectRoot });
  }
  return found;
}
