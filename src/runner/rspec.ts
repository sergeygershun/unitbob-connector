import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, type ProcResult } from '../proc.ts';
import { GUARDRAILS_DIR, SUITE_FILE } from '../files/guardrails.ts';

export const RSPEC_TIMEOUT_MS = 10 * 60 * 1000;

export interface RspecRunResult extends ProcResult {
  command: string;
  args: string[];
}

// Run the full materialised guardrail suite (spec 18).
export async function runRspecSuite(projectRoot: string): Promise<RspecRunResult> {
  const suitePath = join(GUARDRAILS_DIR, SUITE_FILE);
  return invokeRspec(projectRoot, [suitePath, '--format', 'json']);
}

// Run a single example as the reshape gate (spec 21): point RSpec at the
// Rails-assembled candidate spec and filter to the one example by its [test_id]
// tag (the same `-e "[id]"` filter the suite descriptions carry). `specPath` is
// relative to `projectRoot` so the candidate can live under `.unitbob/reshape/`.
export async function runRspecExample(projectRoot: string, specPath: string, testId: string): Promise<RspecRunResult> {
  return invokeRspec(projectRoot, [specPath, '-e', `[${testId}]`, '--format', 'json']);
}

// Prefer the project's own `bin/rspec`; fall back to `bundle exec rspec`. Every
// run sets UNITBOB_REPO_ROOT so the suite header reads the real local source.
async function invokeRspec(projectRoot: string, rspecArgs: string[]): Promise<RspecRunResult> {
  const localRspec = join(projectRoot, 'bin', 'rspec');
  const hasLocalRspec = executable(localRspec);
  const command = hasLocalRspec ? localRspec : 'bundle';
  const args = hasLocalRspec ? rspecArgs : ['exec', 'rspec', ...rspecArgs];

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
