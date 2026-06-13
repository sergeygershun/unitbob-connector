// Per-project config for the connector. Lives in `.unitbob.json` at the project
// root: { "server": "https://…", "repo_id": 3 }. No secret — auth is deferred
// (spec 15, decision #3). Every verb reads it. A missing or malformed file must
// fail with an actionable setup message, never a raw stack trace.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Config {
  server: string;
  repoId: number;
  projectRoot: string;
}

const CONFIG_FILE = '.unitbob.json';

const SETUP_HINT =
  'run `unitbob init`, or create a `.unitbob.json` at your project root with ' +
  '{ "server": "https://your-unitbob-host", "repo_id": <number> }';

// Walk up from `startDir` to the filesystem root looking for `.unitbob.json`.
export function findConfigPath(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(startDir: string = process.cwd()): Config {
  const path = findConfigPath(startDir);
  if (!path) {
    throw new Error(`No ${CONFIG_FILE} found — ${SETUP_HINT}`);
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Could not read ${path} (${(err as Error).message}) — ${SETUP_HINT}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON — ${SETUP_HINT}`);
  }

  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const server = obj.server;
  const repoId = obj.repo_id;

  if (typeof server !== 'string' || server.trim() === '') {
    throw new Error(`${path} is missing a "server" string — ${SETUP_HINT}`);
  }
  if (typeof repoId !== 'number' || !Number.isInteger(repoId)) {
    throw new Error(`${path} is missing an integer "repo_id" — ${SETUP_HINT}`);
  }

  // Trim a trailing slash so callers can join paths without doubling up.
  return { server: server.trim().replace(/\/+$/, ''), repoId, projectRoot: dirname(path) };
}
