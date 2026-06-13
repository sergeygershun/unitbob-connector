import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, type ProcResult } from '../proc.ts';
import { GUARDRAILS_DIR, SUITE_FILE } from '../files/guardrails.ts';

export const RSPEC_TIMEOUT_MS = 10 * 60 * 1000;

export interface RspecRunResult extends ProcResult {
  command: string;
  args: string[];
}

export async function runRspecSuite(projectRoot: string): Promise<RspecRunResult> {
  const localRspec = join(projectRoot, 'bin', 'rspec');
  const suitePath = join(GUARDRAILS_DIR, SUITE_FILE);
  const hasLocalRspec = executable(localRspec);
  const command = hasLocalRspec ? localRspec : 'bundle';
  const args = hasLocalRspec
    ? [suitePath, '--format', 'json']
    : ['exec', 'rspec', suitePath, '--format', 'json'];

  const result = await runProcess(command, args, {
    cwd: projectRoot,
    timeoutMs: RSPEC_TIMEOUT_MS,
    env: { ...process.env, UNITBOB_REPO_ROOT: projectRoot },
  });

  return { ...result, command, args };
}

function executable(path: string): boolean {
  try {
    return existsSync(path) && (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
