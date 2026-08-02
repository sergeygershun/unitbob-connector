// Zero-touch linking (spec 28): every verb starts here. A project is identified
// by its main checkout's folder name (spec 29) and resolved on the server
// idempotently each run. The user never supplies a repo_id; it is an internal
// server key nobody is expected to know.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  CONFIG_FILE,
  locateLinkedRoot,
  readLocalRepoId,
  readLocalServer,
  readLocalToken,
  writeConfigFile,
  type Config,
} from './config.ts';
import { registerRepo, WireError } from './wire.ts';

// Public Unitbob brain used by default. A `server` in `.unitbob.json` (or an
// explicit argument) overrides it — see resolution order in ensureLinked.
export const DEFAULT_SERVER = 'https://unitbob-73a4082838d3.herokuapp.com';

// Make sure this project is linked.
//
// Registering is now a once-per-project event (spec 33). It used to run on every
// command, resolving the repo by folder name and comparing ids — a check that
// stopped meaning anything the moment a name stopped being a key, on the one
// endpoint that answers without a token. What confirms the link now is simply
// the first real call: it carries the token, and a wrong one gets a 404 with an
// explanation.
//
//   - no working link (file missing / repo_id 0 / non-int) → register, write
//     the file with its token, announce in one calm line;
//   - already linked → proceed silently, without touching the server.
//
// The server is resolved in order: explicit argument → `server` from the
// project's own `.unitbob.json` → the public default. The file must win over
// the default, or a locally-linked project would silently register itself on
// the public brain.
//
// `out` is injectable because hijacking process.stdout in tests swallows
// node:test's own runner protocol (which also travels over stdout).
export interface Out {
  write: (chunk: string) => unknown;
}

export async function ensureLinked(
  cwd: string = process.cwd(),
  server?: string,
  out: Out = process.stdout,
): Promise<Config> {
  // An already-linked project answers from its own root, wherever the command
  // was typed. Nothing is linked yet? Then `cwd` is the candidate root and every
  // guard below applies to it unchanged.
  const root = locateLinkedRoot(cwd) ?? cwd;
  const resolvedServer = server ?? readLocalServer(root) ?? DEFAULT_SERVER;
  const fileId = readLocalRepoId(root); // only the root's own file — no walk-up
  const name = projectName(root);

  if (fileId !== null) {
    const token = readLocalToken(root);
    if (token === null) {
      // Linked before the project had a key of its own. There is no way to mint
      // one for an existing project — that would be a door into it — so the only
      // honest instruction is to link again.
      throw new WireError(
        `${CONFIG_FILE} has no project token. It was written by an older Unitbob, and the ` +
          `server now requires one. Delete ${CONFIG_FILE} to link this project again ` +
          '(the old project, along with its map and checks, stays where it is).',
      );
    }
    // Checked on every command, not only at linking: the file holds the only key
    // the project has, and a `.gitignore` rewritten since is how that key ends
    // up in a public repository. Costs nothing when the entry is already there.
    ensureGitignored(root, out);
    return { server: resolvedServer, repoId: fileId, token, projectRoot: root };
  }

  // Refuse before touching the server, so a stray run can't mint a junk repo.
  assertProjectRoot(root);

  const { id, token } = await registerRepo(resolvedServer, name);
  writeConfigFile(root, { server: resolvedServer, repo_id: id, token });
  ensureGitignored(root, out);
  out.write(`Linked this project to Unitbob as ${name}.\n`);

  return { server: resolvedServer, repoId: id, token, projectRoot: root };
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
    const commonGit = commonGitDir(gitdir);
    if (commonGit === null) return basename(cwd); // submodule (`.git/modules/…`) or exotic layout
    if (basename(commonGit) === '.git') return basename(dirname(commonGit));
    return basename(commonGit).replace(/\.git$/, '') || basename(cwd); // bare / separate git dir
  } catch {
    return basename(cwd); // no .git at all — git-less project
  }
}

// The main checkout's git dir for a worktree: git's own `commondir` pointer
// inside the worktree admin dir works for every layout (bare main repo,
// --separate-git-dir); the literal `<root>/.git/worktrees/<slug>` shape is
// the fallback. null means "not a worktree we understand" — the caller falls
// back to basename(cwd), so name resolution never fails linking.
function commonGitDir(gitdir: string): string | null {
  const commondir = join(gitdir, 'commondir');
  if (existsSync(commondir)) return resolve(gitdir, readFileSync(commondir, 'utf8').trim());

  const worktrees = dirname(gitdir);
  if (basename(worktrees) === 'worktrees' && basename(dirname(worktrees)) === '.git') {
    return dirname(worktrees);
  }
  return null;
}

const PROJECT_MARKERS = ['Gemfile', 'gems.rb', 'package.json'];

// Linking writes a file and creates a server row — only do that at a real
// project root: never $HOME or the filesystem root, and the folder must be
// anchored by `.git` or a recognizable project marker (a vibecoder may not use
// version control at all; the marker still keeps junk folders off the brain).
export function assertProjectRoot(cwd: string): void {
  const isFsRoot = dirname(cwd) === cwd;
  const hasGit = existsSync(join(cwd, '.git'));
  const anchored = hasGit || PROJECT_MARKERS.some((marker) => existsSync(join(cwd, marker)));
  if (isFsRoot || cwd === homedir() || !anchored) {
    throw new WireError(
      `${cwd} does not look like a project root (no .git and no project files ` +
        "(Gemfile/package.json) here) — run this from your project's root folder.",
    );
  }

  // A marker without .git can also mean a folder *inside* a bigger project —
  // a monorepo sub-package, a Rails app's frontend/, node_modules. Those must
  // never mint a brain repo: inside a checkout, the root is where .git is.
  if (!hasGit) {
    const enclosing = enclosingCheckout(cwd);
    if (enclosing !== null || cwd.split(sep).includes('node_modules')) {
      const hint = enclosing === null ? 'a dependency folder' : `the project at ${enclosing}`;
      throw new WireError(
        `${cwd} looks like a folder inside ${hint} — run this from your project's root folder.`,
      );
    }
  }
}

// Nearest ancestor carrying a .git, walking up to (but not including) $HOME —
// a dotfiles repo in $HOME must not swallow every git-less project under it.
function enclosingCheckout(cwd: string): string | null {
  const home = homedir();
  for (let dir = dirname(cwd); dir !== home && dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
  }
  return null;
}

const ARTIFACT_DIR = '.unitbob/';
const GITIGNORE = '.gitignore';

// The config and the artifact dir are per-machine state, never committed.
export function ensureGitignored(cwd: string, out: Out = process.stdout): void {
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
  out.write(`Added ${additions.join(', ')} to ${GITIGNORE}.\n`);
}
