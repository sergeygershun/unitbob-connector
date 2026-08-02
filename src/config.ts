// Per-project config for the connector. Lives in `.unitbob.json` at the project
// root: { "server": "http://…", "repo_id": 3 }. No secret — auth is deferred
// (spec 15, decision #3). Linking is automatic (spec 28): every verb goes
// through `ensureLinked` (src/link.ts), which registers the project by folder
// name when there is no working link. Only the project root's own file counts —
// never a parent directory's (no walk-up).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Config {
  server: string;
  repoId: number;
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

export function writeConfigFile(cwd: string, config: { server: string; repo_id: number }): void {
  writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}
