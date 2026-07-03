// Zero-touch linking (spec 28): every verb starts here. A project is identified
// by its folder name — basename(cwd), nothing else — and resolved on the server
// idempotently each run. The user never supplies a repo_id; it is an internal
// server key nobody is expected to know.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { CONFIG_FILE, readLocalRepoId, writeConfigFile, type Config } from './config.ts';
import { registerRepo, WireError } from './wire.ts';

// Grill decision #1: hosted deployment is deferred; the local brain is the only
// server for now, so the URL is a literal.
export const DEFAULT_SERVER = 'http://localhost:3000';

// Make sure this project is linked, resolving the repo by name on every run
// (cheap — the server find-or-creates) and reconciling with the local file:
//   - no working link (file missing / repo_id 0 / non-int) → register, write
//     the file, announce in one calm line;
//   - the file's id matches the name's server id → proceed silently;
//   - mismatch → fail here, before any expensive work — never silently re-link,
//     the file may point at a real repo the user cares about.
export async function ensureLinked(
  cwd: string = process.cwd(),
  server: string = DEFAULT_SERVER,
): Promise<Config> {
  const fileId = readLocalRepoId(cwd); // only cwd's own file — no walk-up
  const name = basename(cwd);

  // Refuse before touching the server, so a stray run can't mint a junk repo.
  if (fileId === null) assertProjectRoot(cwd);

  const authId = await registerRepo(server, name);

  if (fileId === null) {
    writeConfigFile(cwd, { server, repo_id: authId });
    ensureGitignored(cwd);
    process.stdout.write(`Linked this project to Unitbob as ${name}.\n`);
  } else if (fileId !== authId) {
    throw new WireError(
      `${CONFIG_FILE} points at repo ${fileId}, but "${name}" is repo ${authId} on the server. ` +
        `Fix or remove ${CONFIG_FILE} before continuing.`,
    );
  }

  return { server, repoId: authId, projectRoot: cwd };
}

// Linking writes a file and creates a server row — only do that at a real
// project root: a `.git` present, and never at $HOME or the filesystem root.
export function assertProjectRoot(cwd: string): void {
  const isFsRoot = dirname(cwd) === cwd;
  if (isFsRoot || cwd === homedir() || !existsSync(join(cwd, '.git'))) {
    throw new WireError(
      `${cwd} does not look like a project root (no .git here) — ` +
        "run this from your project's root folder.",
    );
  }
}

const ARTIFACT_DIR = '.unitbob/';
const GITIGNORE = '.gitignore';

// The config and the artifact dir are per-machine state, never committed.
export function ensureGitignored(cwd: string): void {
  const gitignorePath = join(cwd, GITIGNORE);
  let current = '';
  if (existsSync(gitignorePath)) {
    current = readFileSync(gitignorePath, 'utf8');
  }

  const lines = current.split('\n').map((line) => line.trim());
  const additions = [CONFIG_FILE, ARTIFACT_DIR].filter((line) => !lines.includes(line));
  if (additions.length === 0) return;

  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${current}${prefix}${additions.join('\n')}\n`);
  process.stdout.write(`Added ${additions.join(', ')} to ${GITIGNORE}.\n`);
}
