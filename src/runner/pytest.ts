import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUARDRAILS_DIR, PYTEST_RESULT_NAME } from '../files/guardrails.ts';
import { projectRootAsSeenByThePlace, runInProject } from './place.ts';
import { locateRunner } from './toolchain.ts';
import { clearReport, readFreshReport, type RunnerResult } from './types.ts';

export const PYTEST_TIMEOUT_MS = 10 * 60 * 1000;

export const PYTEST_RESULT_FILE = join(GUARDRAILS_DIR, PYTEST_RESULT_NAME);

// A minimal runtime config, created or overwritten before each run and passed
// via `-c` so the project's own addopts (e.g. --cov, -n auto) cannot break the
// guardrail run or its JUnit output. Connector-owned: never stored in Rails,
// never part of the suite digest.
export const PYTEST_INI_FILE = join('.unitbob', 'pytest.ini');
export const PYTEST_INI = '[pytest]\naddopts =\n';

// Run the materialised Unitbob guardrail suite with pytest (spec 30) — no
// guessing at Poetry/uv/virtualenv wrappers. Only the guardrail files run; the
// JUnit XML report goes to --junit-xml, not stdout. The command is
// connector-owned: the suite artifact never carries a command string.
//
// Every file of the branch is named positionally (spec one-place-per-rule, §6.5) — a branch is
// one file per assignment now, and pytest takes as many paths as it is given.
//
// Which pytest is a single question answered in one place (`locateRunner`), so
// the precheck, the boot check and this run can never end up talking about
// different interpreters. `python` is the last resort when nothing was found:
// spawning it produces the honest "No module named pytest" rather than a silent
// no-op, and the checks upstream have already had their chance to say so first.
export async function runPytestSuite(projectRoot: string, suitePaths: string[]): Promise<RunnerResult> {
  writeFileSync(join(projectRoot, PYTEST_INI_FILE), PYTEST_INI);

  const located = locateRunner(projectRoot, 'pytest');
  const command = located?.command ?? 'python';
  const args = [
    ...(located?.args ?? ['-m', 'pytest']),
    '-c',
    PYTEST_INI_FILE,
    ...suitePaths,
    `--junit-xml=${PYTEST_RESULT_FILE}`,
  ];

  const reportPath = join(projectRoot, PYTEST_RESULT_FILE);
  const survivor = clearReport(reportPath);

  const run = await runInProject(projectRoot, command, args, {
    timeoutMs: PYTEST_TIMEOUT_MS,
    env: { ...located?.env, UNITBOB_REPO_ROOT: projectRootAsSeenByThePlace(projectRoot) },
  });

  return {
    ...run,
    resultPath: PYTEST_RESULT_FILE,
    report: readFreshReport(reportPath, survivor),
  };
}
