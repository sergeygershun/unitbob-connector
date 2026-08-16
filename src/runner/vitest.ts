import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runProcess } from '../proc.ts';
import { GUARDRAILS_DIR } from '../files/guardrails.ts';
import { locateRunner } from './toolchain.ts';
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
// (spec 30). Only the guardrail files run — the path arguments filter the run.
//
// A bare `vitest run <file>` treats each path as a filter that is intersected
// with the project's `test.include`, so a project whose include does not cover
// `.unitbob/` would collect no tests. So the config Unitbob writes names every
// file of the branch in `include`, and the positional filters keep the run to
// exactly those files.
//
// Named files rather than a directory glob, since spec 43, §6.5 made a branch
// several files: the artifact already says which files it is, and a glob would
// have to guess a naming convention nothing enforces. `include` is written even
// when the project has no config of its own — Vitest's default include only
// covers `.unitbob/` for a file that happens to be named `*.test.ts`, which is a
// trap set for whoever names a slice after its capability.
//
// The JSON report goes to --outputFile, not stdout, so app logging can never
// corrupt it. The command is connector-owned: the suite artifact never carries
// a command string.
export async function runVitestSuite(projectRoot: string, suitePaths: string[]): Promise<RunnerResult> {
  const configArgs = writeMergedConfig(projectRoot, suitePaths);

  // An installed vitest — the sidecar's, else the project's — is spawned by
  // path. `npx` stays as the last resort it has always been: it is the only
  // option that can conjure a runner out of nothing, which is right here at the
  // end and wrong everywhere else (see `locateRunner`, which does not offer it).
  const located = locateRunner(projectRoot, 'vitest');
  const command = located?.command ?? 'npx';
  const args = [
    ...(located ? located.args : ['vitest']),
    'run',
    ...suitePaths,
    ...configArgs,
    '--reporter=json',
    `--outputFile=${VITEST_RESULT_FILE}`,
  ];

  const result = await runProcess(command, args, {
    cwd: projectRoot,
    timeoutMs: VITEST_TIMEOUT_MS,
    env: { ...process.env, ...located?.env, UNITBOB_REPO_ROOT: projectRoot },
  });

  return {
    ...result,
    command,
    args,
    resultPath: VITEST_RESULT_FILE,
    report: readReport(join(projectRoot, VITEST_RESULT_FILE)),
  };
}

// Returns the `--config` args to add, writing the config first. Always written:
// the branch's files have to be in `include` or nothing is collected, and the
// names a worker gives its slice are not something to bet a whole run on.
function writeMergedConfig(projectRoot: string, suitePaths: string[]): string[] {
  const projectConfig = PROJECT_CONFIGS.find((name) => existsSync(join(projectRoot, name)));

  const path = join(projectRoot, VITEST_CONFIG_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, configSource(projectConfig, suitePaths));
  return ['--config', VITEST_CONFIG_FILE];
}

// The .unitbob/ config sits one level below the project root, so the project
// config is a `../` import. A function-form config is resolved first, and
// everything the project set — plugins, aliases, setup files, environment — is
// carried through; only `test.include` is replaced, with exactly this branch's
// files. Replacing rather than concatenating is the point: the run must be these
// files and no others, and the positional filters then say the same thing twice.
//
// Nothing is imported from `vitest` itself, and that is deliberate. Vite
// re-imports this generated file from a temporary module beside it, so every
// bare `import` here resolves by walking up from `.unitbob/` — while a project
// whose only vitest is the one Unitbob installed keeps it at
// `.unitbob/runners/node_modules`, which is not on that path. An
// `import { mergeConfig } from 'vitest/config'` there dies with
// ERR_MODULE_NOT_FOUND before a single test is collected, on exactly the
// projects the sidecar exists for. A spread does the same job with no import,
// and `defineConfig` is a typing helper that buys a generated file nothing.
function configSource(projectConfig: string | undefined, suitePaths: string[]): string {
  const include = `include: ${JSON.stringify(suitePaths)}`;
  const header = '// Written by the unitbob connector before each vitest run — do not edit.';

  if (!projectConfig) {
    return `${header}
export default { test: { ${include} } };
`;
  }

  return `${header}
import projectConfig from ${JSON.stringify(`../${projectConfig}`)};

const base = typeof projectConfig === 'function'
  ? await projectConfig({ command: 'serve', mode: 'test' })
  : projectConfig;

export default { ...base, test: { ...(base.test ?? {}), ${include} } };
`;
}
