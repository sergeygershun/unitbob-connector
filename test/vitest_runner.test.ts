import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runVitestSuite, VITEST_CONFIG_FILE } from '../src/runner/vitest.ts';

const suitePath = '.unitbob/guardrails/architecture_map_contracts.test.ts';

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

  const result = await withFakeNpx(() => runVitestSuite(projectRoot, suitePath));

  assert.ok(result.args.includes('--config'), 'passes --config');
  assert.ok(result.args.includes(VITEST_CONFIG_FILE), 'points at the connector config');

  const written = readFileSync(join(projectRoot, VITEST_CONFIG_FILE), 'utf8');
  assert.match(written, /mergeConfig/);
  assert.ok(written.includes('"../vitest.config.ts"'), 'inherits the project config');
  assert.ok(written.includes(suitePath), 'adds the guardrail file to include');
});

test('prefers vitest.config over vite.config when both exist', async () => {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, 'vite.config.ts'), 'export default {};\n');
  writeFileSync(join(projectRoot, 'vitest.config.ts'), 'export default {};\n');

  await withFakeNpx(() => runVitestSuite(projectRoot, suitePath));

  const written = readFileSync(join(projectRoot, VITEST_CONFIG_FILE), 'utf8');
  assert.ok(written.includes('"../vitest.config.ts"'), 'the more specific config wins');
});

test('with no project config, runs the bare command and writes nothing', async () => {
  const projectRoot = tmpProject();

  const result = await withFakeNpx(() => runVitestSuite(projectRoot, suitePath));

  assert.ok(!result.args.includes('--config'), 'no --config when defaults already cover .unitbob/');
  assert.equal(existsSync(join(projectRoot, VITEST_CONFIG_FILE)), false);
});
