// `unitbob init` — link this project to Unitbob (spec 28: zero-touch). Kept as
// an explicit verb so setup can be scripted, but every other verb links
// automatically too; running it twice is safe.
import { basename } from 'node:path';
import { readLocalRepoId } from '../config.ts';
import { ensureGitignored, ensureLinked } from '../link.ts';

export async function init(_args: string[]): Promise<void> {
  const cwd = process.cwd();
  const alreadyLinked = readLocalRepoId(cwd) !== null;

  await ensureLinked(cwd); // announces on a fresh link; throws on a mismatch

  if (alreadyLinked) {
    process.stdout.write(`Already linked as ${basename(cwd)} — leaving .unitbob.json untouched.\n`);
  }
  ensureGitignored(cwd);
}
