import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess, type ProcResult } from '../proc.ts';
import { readReport, type RunnerResult } from './types.ts';
import { PYTEST_BDD_PLUGIN } from './pytestBddPlugin.ts';

export const BDD_TIMEOUT_MS = 10 * 60 * 1000;

// The behavioral suite lives under one root; the report is written inside it so
// the app under test cannot pollute it and it travels with the suite.
const BEHAVIORAL_ROOT = '.unitbob/behavioral';
const CUCUMBER_REPORT = join(BEHAVIORAL_ROOT, 'cucumber_messages.ndjson');
const PYTEST_BDD_REPORT = join(BEHAVIORAL_ROOT, 'pytest_bdd_report.json');
const PYTEST_BDD_PLUGIN_FILE = join(BEHAVIORAL_ROOT, 'unitbob_pytest_bdd_plugin.py');
const PYTEST_INI_FILE = join(BEHAVIORAL_ROOT, 'pytest.ini');
const PYTEST_INI = '[pytest]\naddopts =\n';

// The connector-owned BDD strategy table (spec 32): the `runner` enum names one
// of these; the connector never executes a host-provided command string. Each
// strategy runs the whole behavioral bundle and returns the raw machine-readable
// report verbatim — the connector does no marker join and no aggregation.
export function runBddSuite(projectRoot: string, runner: string, mainPath: string): Promise<RunnerResult> {
  switch (runner) {
    case 'cucumber':
      return runCucumberRuby(projectRoot);
    case 'cucumber-js':
      return runCucumberJs(projectRoot);
    case 'pytest-bdd':
      return runPytestBdd(projectRoot, mainPath);
    default:
      return Promise.reject(new Error(`Unsupported BDD runner "${runner}" — rebuild the behavioral suite.`));
  }
}

// Ruby: `cucumber` with the built-in message formatter. The features and step
// definitions both live under the behavioral root; --require points at the step
// definitions so only the Unitbob bundle loads.
async function runCucumberRuby(projectRoot: string): Promise<RunnerResult> {
  const features = join(BEHAVIORAL_ROOT, 'features');
  const steps = join(BEHAVIORAL_ROOT, 'step_definitions');
  const localBin = join(projectRoot, 'bin', 'cucumber');
  const sidecarGemfile = join(projectRoot, BEHAVIORAL_ROOT, 'Gemfile');
  const hasSidecarGemfile = existsSync(sidecarGemfile);

  const command = executable(localBin) ? localBin : 'bundle';
  const base = executable(localBin) ? [] : ['exec', 'cucumber'];
  const args = [...base, features, '--require', steps, '--format', 'message', '--out', CUCUMBER_REPORT];

  const env: Record<string, string> = {
    ...process.env,
    RAILS_ENV: 'test',
    UNITBOB_REPO_ROOT: projectRoot,
  };
  if (hasSidecarGemfile) {
    env.BUNDLE_GEMFILE = join(BEHAVIORAL_ROOT, 'Gemfile');
  }

  const result = await runProcess(command, args, {
    cwd: projectRoot,
    timeoutMs: BDD_TIMEOUT_MS,
    env,
  });

  return finalize(result, command, args, projectRoot, CUCUMBER_REPORT);
}

// JS/TS: `@cucumber/cucumber` (cucumber-js) with the message formatter written
// to a file.
async function runCucumberJs(projectRoot: string): Promise<RunnerResult> {
  const features = join(BEHAVIORAL_ROOT, 'features');
  const steps = join(BEHAVIORAL_ROOT, 'step_definitions', '**', '*');
  const sidecarBin = join(projectRoot, BEHAVIORAL_ROOT, 'node_modules', '.bin', 'cucumber-js');

  const command = executable(sidecarBin) ? sidecarBin : 'npx';
  const baseArgs = executable(sidecarBin) ? [] : ['cucumber-js'];
  const args = [
    ...baseArgs,
    features,
    '--require',
    steps,
    '--format',
    `message:${CUCUMBER_REPORT}`,
  ];

  const result = await runProcess(command, args, {
    cwd: projectRoot,
    timeoutMs: BDD_TIMEOUT_MS,
    env: { ...process.env, NODE_ENV: 'test', UNITBOB_REPO_ROOT: projectRoot },
  });

  return finalize(result, command, args, projectRoot, CUCUMBER_REPORT);
}

// Python: pytest driving pytest-bdd, with the connector's reporter plugin. The
// plugin writes the JSON report; `-c` isolates the run from the project's own
// addopts. The runner command is connector-owned.
async function runPytestBdd(projectRoot: string, mainPath: string): Promise<RunnerResult> {
  mkdirSync(join(projectRoot, BEHAVIORAL_ROOT), { recursive: true });
  writeFileSync(join(projectRoot, PYTEST_INI_FILE), PYTEST_INI);
  writeFileSync(join(projectRoot, PYTEST_BDD_PLUGIN_FILE), PYTEST_BDD_PLUGIN);

  const command = await pickPython(projectRoot);
  const stepsDir = join(BEHAVIORAL_ROOT, 'step_definitions');
  const isVenvPytest = command.endsWith('/pytest');
  const args = isVenvPytest
    ? ['-c', PYTEST_INI_FILE, '-p', 'no:cacheprovider', '-p', pluginModule(), stepsDir, '--rootdir', projectRoot]
    : ['-m', 'pytest', '-c', PYTEST_INI_FILE, '-p', 'no:cacheprovider', '-p', pluginModule(), stepsDir, '--rootdir', projectRoot];

  const result = await runProcess(command, args, {
    cwd: projectRoot,
    timeoutMs: BDD_TIMEOUT_MS,
    env: {
      ...process.env,
      UNITBOB_REPO_ROOT: projectRoot,
      UNITBOB_PYTEST_BDD_REPORT: join(projectRoot, PYTEST_BDD_REPORT),
      PYTHONPATH: [join(projectRoot, BEHAVIORAL_ROOT), process.env.PYTHONPATH ?? ''].filter(Boolean).join(':'),
    },
  });

  return finalize(result, command, args, projectRoot, PYTEST_BDD_REPORT);
  // mainPath is accepted for symmetry with the structural runners; pytest-bdd
  // discovers scenarios from the step-definition modules, not the .feature path.
}

function pluginModule(): string {
  return 'unitbob_pytest_bdd_plugin';
}

function finalize(
  result: ProcResult,
  command: string,
  args: string[],
  projectRoot: string,
  reportRel: string,
): RunnerResult {
  return {
    ...result,
    command,
    args,
    resultPath: reportRel,
    report: readReport(join(projectRoot, reportRel)),
  };
}

async function pickPython(projectRoot: string): Promise<string> {
  const sidecarVenvPytest = join(projectRoot, BEHAVIORAL_ROOT, '.venv', 'bin', 'pytest');
  if (executable(sidecarVenvPytest)) {
    return sidecarVenvPytest;
  }

  const probe = await runProcess('python3', ['-m', 'pytest', '--version'], {
    cwd: projectRoot,
    timeoutMs: 10_000,
  }).catch(() => ({ stdout: '', stderr: '', code: 1 }));
  return probe.code === 0 ? 'python3' : 'python';
}

function executable(path: string): boolean {
  try {
    return existsSync(path) && (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
