import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GUARDRAILS_DIR } from '../files/guardrails.ts';
import { projectRootAsSeenByThePlace, runInProject } from './place.ts';
import { locateRunner } from './toolchain.ts';
import { clearReport, readFreshReport, type RunnerResult } from './types.ts';

export const VITEST_TIMEOUT_MS = 10 * 60 * 1000;

export const VITEST_RESULT_FILE = join(GUARDRAILS_DIR, 'vitest_result.json');

// A connector-owned Vitest config, written next to .unitbob/ before a run when
// the project has its own config. Connector-owned: never stored in Rails, never
// part of the suite digest.
export const VITEST_CONFIG_FILE = join('.unitbob', 'vitest.config.mjs');

// The boot check's own config (spec 38), kept in a separate file from the one
// above rather than shared with it. The two answer different questions and are
// alive at different moments — the run's config names the branch's suite files
// and is rewritten immediately before every run, so a boot check that reused it
// would either be overwritten or leave the run pointing at a probe.
export const VITEST_BOOT_CONFIG_FILE = join('.unitbob', 'vitest.boot.config.mjs');

// The structural branch's one shared setup file (spec 39). The coordinator
// writes it before fan-out and owns it afterwards: it holds whatever has to
// happen before the first import of any file of the branch — environment
// variables, a TypeScript loader registration, at the very last resort an entry
// through the project's root module.
//
// A fixed name rather than a new protocol field, because the file has to survive
// the round trip: `materializeGuardrails` wipes this directory and lays the
// artifact out again, so the file must travel as an ordinary `support_files`
// entry — and every such entry is otherwise handed to the runner as a test path.
// One constant here, read by the config builder, by both collectors of test
// paths, and by `suite-prepare`, is the whole of the agreement. A field would
// have had to be agreed with the server and both of its version models.
//
// One name, one extension. A second one buys nothing: vitest puts every setup
// file through vite, so `require` is undefined in a `.js` setup file just as it
// is in a `.ts` one.
export const STRUCTURAL_SETUP_FILE = '.unitbob/structural/_setup.ts';

// The project-relative path of that file, or `undefined` when it has not been
// written yet. Two callers, one question: the config builder asks it to decide
// whether to name the file in `setupFiles`, and `suite-prepare` asks it to
// decide whether the boot probe is a scout or a sentry (spec 39, criterion 4).
// Deliberately the same observable fact for both, rather than a flag — 32-6
// forbids a mode, and a mode would let the two sides disagree about which run
// they are in.
export function setupFileOf(projectRoot: string): string | undefined {
  return existsSync(join(projectRoot, STRUCTURAL_SETUP_FILE)) ? STRUCTURAL_SETUP_FILE : undefined;
}

// Whether anything of ours can run before this stack's branch imports its first
// module. Only vitest, because `setupFiles` is a vitest notion and the builder
// below is the single place that inserts our file. Kept here, beside the
// insertion it describes, rather than in the verb that asks: the verb would be
// stating a fact about a module it does not own, and the two could then drift.
export function canPrepareBeforeImports(runner: string | null): boolean {
  return runner === 'vitest';
}

// The files of an artifact that a runner may be pointed at, which is all of them
// except the shared setup file. It travels as an ordinary `support_files` entry
// so that materialization writes it back rather than wiping it, and it holds no
// cases at all: a runner given it as a test path opens it, finds nothing, and
// reports that nothing as a suite.
//
// One filter for both collectors — the check flow's and run-local's — because
// the two must never disagree about which file this is. A leading `./` is
// tolerated: the answer that names the file is hand-written, and two characters
// must not be what decides whether the branch's preparation is executed or
// collected.
export function testPathsOf(paths: string[]): string[] {
  return paths.filter((path) => path.replace(/^\.\//, '') !== STRUCTURAL_SETUP_FILE);
}

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
// Named files rather than a directory glob, since spec one-place-per-rule, §6.5 made a branch
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

  const reportPath = join(projectRoot, VITEST_RESULT_FILE);
  const survivor = clearReport(reportPath);

  const run = await runInProject(projectRoot, command, args, {
    timeoutMs: VITEST_TIMEOUT_MS,
    env: { ...located?.env, UNITBOB_REPO_ROOT: projectRootAsSeenByThePlace(projectRoot) },
  });

  return {
    ...run,
    resultPath: VITEST_RESULT_FILE,
    report: readFreshReport(reportPath, survivor),
  };
}

// Returns the `--config` args to add, writing the config first. Always written:
// the branch's files have to be in `include` or nothing is collected, and the
// names a worker gives its slice are not something to bet a whole run on.
function writeMergedConfig(projectRoot: string, suitePaths: string[]): string[] {
  const path = join(projectRoot, VITEST_CONFIG_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, configSource(projectConfigOf(projectRoot), suitePaths, 'run', setupFileOf(projectRoot)));
  return ['--config', VITEST_CONFIG_FILE];
}

// The same config, shaped for the boot check's probe (spec 38). Returned as text
// rather than written, because the boot check owns the lifetime of every file it
// puts in the project: it writes them together and removes them together, and a
// writer here would take half of that away from the one place that can see it.
export function vitestBootConfigSource(projectRoot: string, probePath: string): string {
  // The same preparation the run will get, which is the point of asking twice
  // (spec 39, criterion 4). On the first `suite-prepare` there is no setup file
  // and the probe answers "these files do not load on their own"; on the second,
  // after the coordinator wrote one, it answers the question the run will
  // actually put — and only then is a red answer worth a branch.
  return configSource(projectConfigOf(projectRoot), [probePath], 'boot', setupFileOf(projectRoot));
}

function projectConfigOf(projectRoot: string): string | undefined {
  return PROJECT_CONFIGS.find((name) => existsSync(join(projectRoot, name)));
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
// `mode` is the boot check's two differences from the run, and they go together:
// globals on, and a workspace refused. See `vitestBootConfigSource`.
//
// `setupFiles` is the one field that is added to rather than replaced (spec 39,
// criterion 2). The project's own entry is what raises its test database and
// reads its environment — epic-stack's `tests/setup/setup-test-env.ts` is why
// its 50 structural checks have a database to read — and replacing it would
// take that away from the only structural suite on the bench that works. Ours
// goes first: it exists to set things up before the first import of anything,
// and the project's own setup file opens with imports of the application.
function configSource(
  projectConfig: string | undefined,
  suitePaths: string[],
  mode: 'run' | 'boot',
  setupFile: string | undefined,
): string {
  // After the project's own `test`, never before it: ours has to win.
  const settings = `${mode === 'boot' ? 'globals: true, ' : ''}${setupFile ? 'setupFiles, ' : ''}include: ${JSON.stringify(suitePaths)}`;
  const header = '// Written by the unitbob connector before each vitest run — do not edit.';

  if (!projectConfig) {
    // Nothing to inherit, so nothing to concatenate — but the shared file is
    // still the branch's, and a project with no config of its own is exactly
    // the kind that needs it.
    const alone = setupFile ? `const setupFiles = ${JSON.stringify([setupFile])};\n` : '';
    return `${header}
${alone}export default { test: { ${settings} } };
`;
  }

  // Globals, because the probe lives in `.unitbob/structural/`: an
  // `import { test } from 'vitest'` there resolves by walking up from that
  // directory, which never reaches `.unitbob/runners/node_modules` — where the
  // vitest we installed for a project that had none is kept. We write this file,
  // so we turn the globals on and the probe needs no import at all.
  //
  // A workspace is dropped for a harder reason. With `test.projects` (or the
  // older `test.workspace`) set, the root `include` stops deciding anything and
  // vitest runs each sub-project's own test files — which would open the
  // project's tests again through the back door, the one thing spec 38 removes.
  const narrow =
    mode === 'boot'
      ? `
const { projects, workspace, ...test } = base.test ?? {};
`
      : `
const test = base.test ?? {};
`;

  // `[].concat(x)` on purpose: vitest accepts `setupFiles` as an array or as a
  // bare string, and most projects set neither. All three forms arrive here and
  // all three have to come out an array, because a config that throws while it
  // is being read takes the whole run with it.
  const merge = setupFile
    ? `const setupFiles = ${JSON.stringify([setupFile])}.concat(test.setupFiles ?? []);\n`
    : '';

  return `${header}
import projectConfig from ${JSON.stringify(`../${projectConfig}`)};

const base = typeof projectConfig === 'function'
  ? await projectConfig({ command: 'serve', mode: 'test' })
  : projectConfig;
${narrow}${merge}
export default { ...base, test: { ...test, ${settings} } };
`;
}
