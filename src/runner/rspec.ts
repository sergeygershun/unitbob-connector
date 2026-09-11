import { join } from 'node:path';
import { GUARDRAILS_DIR, OPTIONS_FILE, RSPEC_RESULT_NAME } from '../files/guardrails.ts';
import { projectRootAsSeenByThePlace, runInProject, type ProjectRun } from './place.ts';
import { locateRunner } from './toolchain.ts';
import { clearReport, readFreshReport, type RunnerResult } from './types.ts';

export const RSPEC_TIMEOUT_MS = 10 * 60 * 1000;

// Spec 26: the Unitbob file runs in a defined order with a fixed seed so a
// green→red flip can never come from run-order nondeterminism. It does not inherit
// the project's random ordering.
export const RSPEC_SEED = '1';

export const RSPEC_RESULT_FILE = join(GUARDRAILS_DIR, RSPEC_RESULT_NAME);

// Run the materialised Unitbob guardrail suite (spec 26). Only these files run —
// never the project's full suite — under RAILS_ENV=test with a fixed order/seed.
// --options points at the materialized empty file so the project's own .rspec
// (a --require of a helper we replaced, an extra stdout formatter) can neither
// break the boot nor corrupt the JSON output. The JSON report goes to `--out`
// (a file), not stdout, so the app's own stdout writes during the run can never
// corrupt it.
//
// `suitePaths` is every file of the branch in the suite blob's own
// project-relative form (spec one-place-per-rule, §6.5). Named one by one rather than as a
// directory: the artifact already says exactly which files it is, while a
// directory would also collect whatever else happens to be sitting under the
// root.
export async function runRspecSuite(projectRoot: string, suitePaths: string[]): Promise<RunnerResult> {
  const optionsPath = join(GUARDRAILS_DIR, OPTIONS_FILE);
  const reportPath = join(projectRoot, RSPEC_RESULT_FILE);
  const survivor = clearReport(reportPath);

  const run = await invokeRspec(projectRoot, [
    ...suitePaths,
    '--options',
    optionsPath,
    '--order',
    'defined',
    '--seed',
    RSPEC_SEED,
    '--format',
    'json',
    '--out',
    RSPEC_RESULT_FILE,
  ]);

  return {
    ...run,
    resultPath: RSPEC_RESULT_FILE,
    report: readFreshReport(reportPath, survivor),
  };
}

// Which rspec — the sidecar Unitbob installed, the project's own `bin/rspec`
// binstub, or `bundle exec rspec` — is decided once, in `locateRunner`, so this
// run and the checks that predicted it always mean the same installation. Every
// run sets RAILS_ENV=test so guardrails execute against the Rails test
// environment the project's `rails_helper` configures.
async function invokeRspec(projectRoot: string, rspecArgs: string[]): Promise<ProjectRun> {
  const located = locateRunner(projectRoot, 'rspec');
  const command = located?.command ?? 'bundle';
  const args = [...(located?.args ?? ['exec', 'rspec']), ...rspecArgs];

  return runInProject(projectRoot, command, args, {
    timeoutMs: RSPEC_TIMEOUT_MS,
    env: {
      ...located?.env,
      RAILS_ENV: 'test',
      UNITBOB_REPO_ROOT: projectRootAsSeenByThePlace(projectRoot),
    },
  });
}
