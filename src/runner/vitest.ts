import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProcess } from '../proc.ts';
import { GUARDRAILS_DIR } from '../files/guardrails.ts';
import { readReport, type RunnerResult } from './types.ts';

export const VITEST_TIMEOUT_MS = 10 * 60 * 1000;

export const VITEST_RESULT_FILE = join(GUARDRAILS_DIR, 'vitest_result.json');

// A connector-owned Vitest config, written next to .unitbob/ before a run when
// the project has its own config. Connector-owned: never stored in Rails, never
// part of the suite digest.
export const VITEST_CONFIG_FILE = join('.unitbob', 'vitest.config.mjs');

// The project configs we inherit from, most specific first. Vitest reads a
// project's own config even when we pass `--config`, so we must merge ours with
// it rather than replace it (plugins, path aliases and resolve settings the
// guardrail file needs all live there).
const PROJECT_CONFIGS = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.cts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
];

// Run the materialised Unitbob guardrail suite with the project's own Vitest
// (spec 30). Only the guardrail file runs — the path argument filters the run.
//
// A bare `vitest run <file>` treats the path as a filter that is intersected
// with the project's `test.include`, so a project whose include does not cover
// `.unitbob/` would collect no tests. When the project has its own config we
// therefore write a tiny config that merges it and adds the guardrail file to
// `include`; the positional filter still narrows the run to that one file. With
// no project config, Vitest's default include already covers `.unitbob/`, so
// the bare command is correct and we write nothing.
//
// The JSON report goes to --outputFile, not stdout, so app logging can never
// corrupt it. The command is connector-owned: the suite artifact never carries
// a command string.
export async function runVitestSuite(projectRoot: string, suitePath: string): Promise<RunnerResult> {
  const configArgs = writeMergedConfig(projectRoot, suitePath);

  const command = 'npx';
  const args = ['vitest', 'run', suitePath, ...configArgs, '--reporter=json', `--outputFile=${VITEST_RESULT_FILE}`];

  const result = await runProcess(command, args, {
    cwd: projectRoot,
    timeoutMs: VITEST_TIMEOUT_MS,
    env: { ...process.env, UNITBOB_REPO_ROOT: projectRoot },
  });

  return {
    ...result,
    command,
    args,
    resultPath: VITEST_RESULT_FILE,
    report: readReport(join(projectRoot, VITEST_RESULT_FILE)),
  };
}

// Returns the `--config` args to add, writing the merge config first. When the
// project has no config of its own there is nothing to inherit and nothing to
// override (defaults already cover .unitbob/), so we return no args.
function writeMergedConfig(projectRoot: string, suitePath: string): string[] {
  const projectConfig = PROJECT_CONFIGS.find((name) => existsSync(join(projectRoot, name)));
  if (!projectConfig) return [];

  writeFileSync(join(projectRoot, VITEST_CONFIG_FILE), mergedConfigSource(projectConfig, suitePath));
  return ['--config', VITEST_CONFIG_FILE];
}

// The .unitbob/ config sits one level below the project root, so the project
// config is a `../` import. `mergeConfig` concatenates `include`, so the
// guardrail file joins the project's patterns instead of replacing them; the
// positional filter then isolates it. A function-form config is resolved first.
function mergedConfigSource(projectConfig: string, suitePath: string): string {
  return `// Written by the unitbob connector before each vitest run — do not edit.
import { mergeConfig } from 'vitest/config';
import projectConfig from ${JSON.stringify(`../${projectConfig}`)};

const base = typeof projectConfig === 'function'
  ? await projectConfig({ command: 'serve', mode: 'test' })
  : projectConfig;

export default mergeConfig(base, {
  test: { include: [${JSON.stringify(suitePath)}] },
});
`;
}
