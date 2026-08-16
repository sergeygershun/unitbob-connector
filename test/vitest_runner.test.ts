import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runVitestSuite, VITEST_CONFIG_FILE } from '../src/runner/vitest.ts';

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
