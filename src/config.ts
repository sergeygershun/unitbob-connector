// Per-project config for the connector. Lives in `.unitbob.json` at the project
// root: { "server": "http://…", "repo_id": 3, "token": "…" }.
//
// The token is the project's key (spec 33): the brain mints it at register, every
// wire call carries it, and this file is the only place a person has it. It is
// gitignored — see ensureGitignored — because a committed token hands the project
// to whoever reads the repository. Lose the file and the project is gone: there
// is no recovery and no rotation, which is written down in the spec as accepted.
//
// Linking is automatic (spec 28): every verb goes
// through `ensureLinked` (src/link.ts), which registers the project by folder
// name when there is no working link. Only the project root's own file counts —
// never a parent directory's (no walk-up).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Config {
  server: string;
  repoId: number;
  token: string;
  projectRoot: string;
}

export const CONFIG_FILE = '.unitbob.json';

// The repo id stored at `cwd`, or null when there is no working link: file
// missing, unreadable, malformed JSON, or repo_id absent / 0 / non-integer
// (the legacy init template wrote repo_id: 0). Callers re-link on null.
export function readLocalRepoId(cwd: string): number | null {
  const repoId = readConfigField(cwd, 'repo_id');
  return typeof repoId === 'number' && Number.isInteger(repoId) && repoId > 0 ? repoId : null;
}

// The server URL stored at `cwd`, or null when the file is missing, malformed,
// or carries no usable http(s) URL. A local file naming a server must win over
// the built-in default — otherwise a locally-linked project silently talks to
// (and registers itself on) the public brain.
export function readLocalServer(cwd: string): string | null {
  const server = readConfigField(cwd, 'server');
  return typeof server === 'string' && /^https?:\/\//.test(server.trim()) ? server.trim() : null;
}

// The token stored at `cwd`, or null when there is none. A project linked
// before spec 33 has an id and no token; its calls now 404, and the connector
// says so in words rather than showing a bare status.
export function readLocalToken(cwd: string): string | null {
  const token = readConfigField(cwd, 'token');
  return typeof token === 'string' && token.length > 0 ? token : null;
}

// The container this project's own processes run in, or null when they run on
// this machine (spec 36). One field, one word: the path inside the container is
// never asked for — it is read off the container's own mounts.
//
//     "exec": { "docker": { "container": "source_code-web-1" } }
//
// Absent means local, and local means byte-for-byte the behaviour this connector
// has always had: no docker call, no new question, no new line of output.
export function readLocalExecContainer(cwd: string): string | null {
  const exec = readConfigField(cwd, 'exec');
  const docker = record(exec)?.['docker'];
  const container = record(docker)?.['container'];
  return typeof container === 'string' && container.trim().length > 0 ? container.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readConfigField(cwd: string, field: string): unknown {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }

  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[field] : undefined;
}

// The nearest directory at or above `cwd` that already carries a working link,
// or null when there is none.
//
// This does not weaken the no-walk-up rule above — it is what makes it usable.
// The rule exists so a parent's repo_id can never stand in for the directory
// the verb is running in; a sub-package would silently report as its monorepo.
// Relocating to the directory whose own file names the link keeps that intact:
// the config still belongs to the root it sits in, and the verb runs there.
// Without this, every command had to be run from exactly the right folder, and
// the request packet's own `project_root` could not be used as a working
// directory even though it names the answer.
//
// $HOME is the ceiling: a stray `.unitbob.json` in the home directory must not
// adopt every project underneath it.
export function locateLinkedRoot(cwd: string): string | null {
  const home = homedir();
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (readLocalRepoId(dir) !== null) return dir;
    if (dir === home || dirname(dir) === dir) return null;
  }
}

// Write the link, and leave everything else in the file alone.
//
// It used to write exactly these three keys and nothing else, which quietly made
// every other key disposable — and this function runs on ordinary events, a
// re-link among them. Somebody who had written `exec` by hand would lose it
// while fixing something unrelated, and the loss says nothing about itself: the
// next run simply goes back to running on this machine.
export function writeConfigFile(
  cwd: string,
  config: { server: string; repo_id: number; token: string },
): void {
  const path = join(cwd, CONFIG_FILE);
  let existing: Record<string, unknown> = {};
  try {
    const parsed = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  } catch {
    // Unparseable, so there is nothing to keep. Writing the link is still the
    // right thing to do — it is what the caller came here for, and the file was
    // no use to anybody in the state it was in.
  }

  writeFileSync(path, `${JSON.stringify({ ...existing, ...config }, null, 2)}\n`);
}
