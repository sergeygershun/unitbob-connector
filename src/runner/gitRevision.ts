import { execFileSync } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';

// The revision a connector-made run was taken at, for the server's record:
// `git rev-parse HEAD`, with `-dirty` when the tree has changes, or a word
// when there is no git to ask. Read by the known-defect probe (the review)
// and by the proof of red of a feature's checks (spec 52-3), from one place.
export function gitRevision(projectRoot: string): string {
  try {
    const options: ExecFileSyncOptionsWithStringEncoding = {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    const head = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], options).trim();
    return dirty ? `${head}-dirty` : head;
  } catch {
    return 'working-tree';
  }
}
