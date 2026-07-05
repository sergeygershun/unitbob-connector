import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, type ProcResult } from '../proc.ts';
import { GUARDRAILS_DIR, OPTIONS_FILE, SUITE_FILE } from '../files/guardrails.ts';

export const RSPEC_TIMEOUT_MS = 10 * 60 * 1000;

// Spec 26: the Unitbob file runs in a defined order with a fixed seed so a
// green→red flip can never come from run-order nondeterminism. It does not inherit
// the project's random ordering.
export const RSPEC_SEED = '1';

export interface RspecRunResult extends ProcResult {
  command: string;
  args: string[];
}

// Run the materialised Unitbob guardrail suite (spec 26). Only this file runs —
// never the project's full suite — under RAILS_ENV=test with a fixed order/seed.
// --options points at the materialized empty file so the project's own .rspec
// (a --require of a helper we replaced, an extra stdout formatter) can neither
// break the boot nor corrupt the JSON output.
export async function runRspecSuite(projectRoot: string): Promise<RspecRunResult> {
  const suitePath = join(GUARDRAILS_DIR, SUITE_FILE);
  const optionsPath = join(GUARDRAILS_DIR, OPTIONS_FILE);
  return invokeRspec(projectRoot, [
    suitePath,
    '--options',
    optionsPath,
    '--order',
    'defined',
    '--seed',
    RSPEC_SEED,
    '--format',
    'json',
  ]);
}

// Prefer the project's own `bin/rspec`; fall back to `bundle exec rspec`. Every
// run sets RAILS_ENV=test so guardrails execute against the Rails test
// environment the project's `rails_helper` configures.
async function invokeRspec(projectRoot: string, rspecArgs: string[]): Promise<RspecRunResult> {
  const localRspec = join(projectRoot, 'bin', 'rspec');
  const hasLocalRspec = executable(localRspec);
  const command = hasLocalRspec ? localRspec : 'bundle';
  const args = hasLocalRspec ? rspecArgs : ['exec', 'rspec', ...rspecArgs];

  const result = await runProcess(command, args, {
    cwd: projectRoot,
    timeoutMs: RSPEC_TIMEOUT_MS,
    env: { ...process.env, RAILS_ENV: 'test', UNITBOB_REPO_ROOT: projectRoot },
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
