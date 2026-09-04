import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  runVitestSuite,
  setupFileOf,
  STRUCTURAL_SETUP_FILE,
  vitestBootConfigSource,
  VITEST_CONFIG_FILE,
} from '../src/runner/vitest.ts';

const suitePath = '.unitbob/structural/architecture_map_contracts.test.ts';

function tmpProject(): string {
  // The check flow materializes the guardrail file (creating .unitbob/) before
  // the run; mirror that so the connector config has a directory to land in.
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-vitest-'));
  mkdirSync(join(dir, '.unitbob', 'guardrails'), { recursive: true });
  return dir;
}

// A fake `npx` on PATH so the runner never shells out to real Vitest.
function withFakeNpx<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-npx-'));
  writeFileSync(join(dir, 'npx'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'npx'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
  return fn().finally(() => {
    process.env.PATH = oldPath;
  });
}

test('with a project vitest config, writes a merge config and passes --config', async () => {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, 'vitest.config.ts'), 'export default {};\n');

  const result = await withFakeNpx(() => runVitestSuite(projectRoot, [suitePath]));

  assert.ok(result.args.includes('--config'), 'passes --config');
  assert.ok(result.args.includes(VITEST_CONFIG_FILE), 'points at the connector config');

  const written = readFileSync(join(projectRoot, VITEST_CONFIG_FILE), 'utf8');
  assert.ok(written.includes('"../vitest.config.ts"'), 'inherits the project config');
  assert.ok(written.includes(suitePath), 'names the guardrail file in include');
});

// The generated config is re-imported by Vite from a temporary module beside
// it, so a bare import resolves by walking up from `.unitbob/` — and a project
// whose only vitest is the one Unitbob installed keeps it under
// `.unitbob/runners/node_modules`, which is not on that path. Importing
// `vitest/config` there dies with ERR_MODULE_NOT_FOUND before a test is
// collected, on exactly the projects the sidecar exists for.
test('the generated config imports nothing from vitest itself', async () => {
  const withConfig = tmpProject();
  writeFileSync(join(withConfig, 'vitest.config.ts'), 'export default {};\n');
  const without = tmpProject();

  for (const projectRoot of [withConfig, without]) {
    await withFakeNpx(() => runVitestSuite(projectRoot, [suitePath]));
    const written = readFileSync(join(projectRoot, VITEST_CONFIG_FILE), 'utf8');
    assert.doesNotMatch(written, /from ['"]vitest/, `${projectRoot} imports vitest`);
  }
});

test('prefers vitest.config over vite.config when both exist', async () => {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, 'vite.config.ts'), 'export default {};\n');
  writeFileSync(join(projectRoot, 'vitest.config.ts'), 'export default {};\n');

  await withFakeNpx(() => runVitestSuite(projectRoot, [suitePath]));

  const written = readFileSync(join(projectRoot, VITEST_CONFIG_FILE), 'utf8');
  assert.ok(written.includes('"../vitest.config.ts"'), 'the more specific config wins');
});

// Spec 43, §6.5. Vitest's default `include` only reaches a `.unitbob/` file that
// happens to be named `*.test.ts`, so leaning on it was a trap set for whoever
// names a slice after the capability it guards: the run collects zero tests and
// reports that as if the suite were empty. The branch's files are now always
// named in `include`, project config or none.
test('with no project config, writes a config that still names the branch files', async () => {
  const projectRoot = tmpProject();

  const result = await withFakeNpx(() => runVitestSuite(projectRoot, [suitePath]));

  assert.ok(result.args.includes('--config'), 'points at the connector config');
  const written = readFileSync(join(projectRoot, VITEST_CONFIG_FILE), 'utf8');
  assert.doesNotMatch(written, /^import /m, 'there is nothing to inherit');
  assert.ok(written.includes(suitePath), 'the branch file is in include');
});

// --- Spec 39: the branch's shared setup file ----------------------------

// The coordinator writes this before fan-out. Here it only has to exist: what is
// in it is the coordinator's business, and the connector's is that it runs
// before the first import of every file of the branch.
function withSetupFile(projectRoot: string): void {
  mkdirSync(join(projectRoot, '.unitbob', 'structural'), { recursive: true });
  writeFileSync(join(projectRoot, STRUCTURAL_SETUP_FILE), '// nothing to prepare here\n');
}

// The generated config, evaluated rather than read as text. The project's own
// entries never appear in our file — they arrive at run time, through the import
// — so the only way to see the merged list, and its order, is to run the merge.
async function generatedConfig(projectRoot: string): Promise<{ test?: Record<string, unknown> }> {
  const module = await import(pathToFileURL(join(projectRoot, VITEST_CONFIG_FILE)).href);
  return module.default as { test?: Record<string, unknown> };
}

// Spec 39, criterion 2. The project's preparation is not ours to replace: on
// epic-stack `tests/setup/setup-test-env.ts` is what raises the test database
// its 50 structural checks read from. Ours is added to it, and goes first —
// their file's own first lines import the application, so anything of ours
// placed after it is already too late.
test('the shared setup file is added to the project\'s own setupFiles, first', async () => {
  const projectRoot = tmpProject();
  writeFileSync(
    join(projectRoot, 'vitest.config.ts'),
    "export default { test: { setupFiles: ['./tests/setup/setup-test-env.ts'] } };\n",
  );
  withSetupFile(projectRoot);

  await withFakeNpx(() => runVitestSuite(projectRoot, [suitePath]));

  const config = await generatedConfig(projectRoot);
  assert.deepEqual(config.test?.setupFiles, [STRUCTURAL_SETUP_FILE, './tests/setup/setup-test-env.ts']);
});

// Vitest accepts a bare string as well as an array, and a project that sets
// neither is the common case. All three forms have to survive the addition —
// `[].concat(x)` swallows the difference, and a config that throws here takes
// the whole run with it.
test('a setupFiles given as a string, or not given at all, survives the addition', async () => {
  const asString = tmpProject();
  writeFileSync(join(asString, 'vitest.config.ts'), "export default { test: { setupFiles: './tests/env.ts' } };\n");
  withSetupFile(asString);
  await withFakeNpx(() => runVitestSuite(asString, [suitePath]));
  assert.deepEqual((await generatedConfig(asString)).test?.setupFiles, [STRUCTURAL_SETUP_FILE, './tests/env.ts']);

  const absent = tmpProject();
  writeFileSync(join(absent, 'vitest.config.ts'), 'export default { test: {} };\n');
  withSetupFile(absent);
  await withFakeNpx(() => runVitestSuite(absent, [suitePath]));
  assert.deepEqual((await generatedConfig(absent)).test?.setupFiles, [STRUCTURAL_SETUP_FILE]);
});

// The other half of the same switch. Before the coordinator has written
// anything there is nothing to prepare with, and a config naming a file that is
// not there fails the run for a reason that has nothing to do with the project.
test('with no setup file on disk, setupFiles is not touched at all', async () => {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, 'vitest.config.ts'), "export default { test: { setupFiles: ['./tests/env.ts'] } };\n");

  await withFakeNpx(() => runVitestSuite(projectRoot, [suitePath]));

  const written = readFileSync(join(projectRoot, VITEST_CONFIG_FILE), 'utf8');
  assert.doesNotMatch(written, /setupFiles/, 'the field is not mentioned at all');
  assert.deepEqual((await generatedConfig(projectRoot)).test?.setupFiles, ['./tests/env.ts']);
});

test('with no project config, the shared setup file is still in setupFiles', async () => {
  const projectRoot = tmpProject();
  withSetupFile(projectRoot);

  await withFakeNpx(() => runVitestSuite(projectRoot, [suitePath]));

  assert.deepEqual((await generatedConfig(projectRoot)).test?.setupFiles, [STRUCTURAL_SETUP_FILE]);
});

// Spec 39, criterion 4, from the connector's side. The probe reaches the branch
// through this same builder, so the second `suite-prepare` — the one run after
// the setup file was written — asks its question through that preparation. That
// is the whole reason the probe may sentence the branch on that run and not
// before it.
test('the boot probe reads the same preparation the run will', () => {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, 'vitest.config.ts'), 'export default {};\n');

  assert.equal(setupFileOf(projectRoot), undefined, 'nothing is prepared yet');
  assert.doesNotMatch(vitestBootConfigSource(projectRoot, '.unitbob/structural/_probe.test.ts'), /setupFiles/);

  withSetupFile(projectRoot);

  assert.equal(setupFileOf(projectRoot), STRUCTURAL_SETUP_FILE);
  assert.match(vitestBootConfigSource(projectRoot, '.unitbob/structural/_probe.test.ts'), /setupFiles/);
});

// Spec 43, §6. One file per assignment, all of them running as one suite.
test('every file of the branch is filtered for and included', async () => {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, 'vitest.config.ts'), 'export default {};\n');
  const second = '.unitbob/structural/reporting.ts';

  const result = await withFakeNpx(() => runVitestSuite(projectRoot, [suitePath, second]));

  assert.ok(result.args.includes(suitePath) && result.args.includes(second), 'both are positional filters');
  const written = readFileSync(join(projectRoot, VITEST_CONFIG_FILE), 'utf8');
  assert.ok(written.includes(suitePath) && written.includes(second), 'both are in include');
});
