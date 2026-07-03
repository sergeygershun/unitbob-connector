// Per-project config for the connector. Lives in `.unitbob.json` at the project
// root: { "server": "http://…", "repo_id": 3 }. No secret — auth is deferred
// (spec 15, decision #3). Linking is automatic (spec 28): every verb goes
// through `ensureLinked` (src/link.ts), which registers the project by folder
// name when there is no working link. Only the project root's own file counts —
// never a parent directory's (no walk-up).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }

  const repoId = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).repo_id : undefined;
  return typeof repoId === 'number' && Number.isInteger(repoId) && repoId > 0 ? repoId : null;
}

export function writeConfigFile(cwd: string, config: { server: string; repo_id: number }): void {
  writeFileSync(join(cwd, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}
