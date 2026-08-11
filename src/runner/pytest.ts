import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess } from '../proc.ts';
import { GUARDRAILS_DIR } from '../files/guardrails.ts';
import { locateRunner } from './toolchain.ts';
import { readReport, type RunnerResult } from './types.ts';

export const PYTEST_TIMEOUT_MS = 10 * 60 * 1000;

export const PYTEST_RESULT_FILE = join(GUARDRAILS_DIR, 'pytest_result.xml');

// A minimal runtime config, created or overwritten before each run and passed
// via `-c` so the project's own addopts (e.g. --cov, -n auto) cannot break the
// guardrail run or its JUnit output. Connector-owned: never stored in Rails,
// never part of the suite digest.
export const PYTEST_INI_FILE = join('.unitbob', 'pytest.ini');
export const PYTEST_INI = '[pytest]\naddopts =\n';

// Run the materialised Unitbob guardrail suite with pytest (spec 30) — no
// guessing at Poetry/uv/virtualenv wrappers. Only the guardrail file runs; the
// JUnit XML report goes to --junit-xml, not stdout. The command is
// connector-owned: the suite artifact never carries a command string.
//
// Which pytest is a single question answered in one place (`locateRunner`), so
// the precheck, the boot check and this run can never end up talking about
// different interpreters. `python` is the last resort when nothing was found:
// spawning it produces the honest "No module named pytest" rather than a silent
// no-op, and the checks upstream have already had their chance to say so first.
export async function runPytestSuite(projectRoot: string, suitePath: string): Promise<RunnerResult> {
  writeFileSync(join(projectRoot, PYTEST_INI_FILE), PYTEST_INI);

  const located = locateRunner(projectRoot, 'pytest');
  const command = located?.command ?? 'python';
  const args = [
    ...(located?.args ?? ['-m', 'pytest']),
    '-c',
    PYTEST_INI_FILE,
    suitePath,
    `--junit-xml=${PYTEST_RESULT_FILE}`,
  ];

  const result = await runProcess(command, args, {
    cwd: projectRoot,
    timeoutMs: PYTEST_TIMEOUT_MS,
    env: { ...process.env, ...located?.env, UNITBOB_REPO_ROOT: projectRoot },
  });

  return {
    ...result,
    command,
    args,
    resultPath: PYTEST_RESULT_FILE,
    report: readReport(join(projectRoot, PYTEST_RESULT_FILE)),
  };
}
