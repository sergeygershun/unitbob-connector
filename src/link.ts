// Zero-touch linking (spec 28): every verb starts here. A project is identified
// by its main checkout's folder name (spec 29) and resolved on the server
// idempotently each run. The user never supplies a repo_id; it is an internal
// server key nobody is expected to know.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
  const name = projectName(cwd);

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

// The linking name is the *project's* name, not the checkout's (spec 29). A
// `.git` directory means cwd is the main checkout; a `.git` file is a worktree
// pointer whose `gitdir:` leads back to the main checkout
// (`<root>/.git/worktrees/<slug>`). No subprocess — the file is parsed
// directly, and anything unexpected (no `.git`, submodules, exotic layouts)
// falls back to basename(cwd): name resolution never fails linking.
export function projectName(cwd: string): string {
  const gitPath = join(cwd, '.git');
  try {
    if (!statSync(gitPath).isFile()) return basename(cwd); // .git directory — main checkout
    const pointer = readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
    if (!pointer) return basename(cwd);

    const gitdir = isAbsolute(pointer[1]) ? pointer[1] : resolve(cwd, pointer[1]);
    const worktrees = dirname(gitdir); // <root>/.git/worktrees
    const commonGit = dirname(worktrees); // <root>/.git
    if (basename(worktrees) === 'worktrees' && basename(commonGit) === '.git') {
      return basename(dirname(commonGit));
    }
    return basename(cwd); // submodule (`.git/modules/…`) or exotic layout
  } catch {
    return basename(cwd); // no .git at all — git-less project
  }
}

const PROJECT_MARKERS = ['Gemfile', 'gems.rb', 'package.json'];

// Linking writes a file and creates a server row — only do that at a real
// project root: never $HOME or the filesystem root, and the folder must be
// anchored by `.git` or a recognizable project marker (a vibecoder may not use
// version control at all; the marker still keeps junk folders off the brain).
export function assertProjectRoot(cwd: string): void {
  const isFsRoot = dirname(cwd) === cwd;
  const anchored =
    existsSync(join(cwd, '.git')) ||
    PROJECT_MARKERS.some((marker) => existsSync(join(cwd, marker)));
  if (isFsRoot || cwd === homedir() || !anchored) {
    throw new WireError(
      `${cwd} does not look like a project root (no .git and no project files ` +
        "(Gemfile/package.json) here) — run this from your project's root folder.",
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
