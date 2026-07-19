// The connector-owned runner strategies (spec 30): `runner_manifest.runner`
// names a built-in argv recipe; only suite and result paths are inserted.
// Host-provided command strings are never executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runVitestSuite, VITEST_RESULT_FILE } from '../src/runner/vitest.ts';
import { runPytestSuite, PYTEST_INI, PYTEST_INI_FILE, PYTEST_RESULT_FILE } from '../src/runner/pytest.ts';

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-runner-'));
  mkdirSync(join(dir, '.unitbob', 'guardrails'), { recursive: true });
  return dir;
}

function fakeBinDir(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-fake-bin-'));
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return dir;
}

async function withPath(dir: string, fn: () => Promise<void>): Promise<void> {
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
  try {
    await fn();
  } finally {
    process.env.PATH = oldPath;
  }
}

test('vitest strategy: npx vitest run <suite> --reporter=json --outputFile=<result>', async () => {
  const projectRoot = tmpProject();
  const fakeBin = fakeBinDir('npx', 'printf \'{"args":"%s","pwd":"%s"}\' "$*" "$(pwd)"');
  const suitePath = '.unitbob/guardrails/architecture_map_contracts.test.ts';

  await withPath(fakeBin, async () => {
    const result = await runVitestSuite(projectRoot, suitePath);

    assert.equal(result.command, 'npx');
    assert.deepEqual(result.args, [
      'vitest',
      'run',
      suitePath,
      '--reporter=json',
      `--outputFile=${VITEST_RESULT_FILE}`,
    ]);
    assert.equal(result.resultPath, VITEST_RESULT_FILE);
  });
});

test('vitest strategy: reads the JSON report from the output file', async () => {
  const projectRoot = tmpProject();
  const fakeBin = fakeBinDir(
    'npx',
    `mkdir -p .unitbob/guardrails; printf '{"testResults":[]}' > ${VITEST_RESULT_FILE}; printf 'app noise'`,
  );

  await withPath(fakeBin, async () => {
    const result = await runVitestSuite(projectRoot, '.unitbob/guardrails/x.test.ts');
    assert.deepEqual(JSON.parse(result.report), { testResults: [] });
    assert.match(result.stdout, /app noise/);
  });
});

test('pytest strategy: python -m pytest -c .unitbob/pytest.ini <suite> --junit-xml=<result>', async () => {
  const projectRoot = tmpProject();
  const fakeBin = fakeBinDir('python3', 'printf \'{"args":"%s","pwd":"%s"}\' "$*" "$(pwd)"');
  const suitePath = '.unitbob/guardrails/test_architecture_map_contracts.py';

  await withPath(fakeBin, async () => {
    const result = await runPytestSuite(projectRoot, suitePath);

    assert.equal(result.command, 'python3');
    assert.deepEqual(result.args, [
      '-m',
      'pytest',
      '-c',
      PYTEST_INI_FILE,
      suitePath,
      `--junit-xml=${PYTEST_RESULT_FILE}`,
    ]);
    assert.equal(result.resultPath, PYTEST_RESULT_FILE);
  });
});

test('pytest strategy: creates the runtime .unitbob/pytest.ini before each run, suppressing project addopts', async () => {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, PYTEST_INI_FILE), '[pytest]\naddopts = --cov\n');
  const fakeBin = fakeBinDir('python3', 'true');

  await withPath(fakeBin, async () => {
    await runPytestSuite(projectRoot, '.unitbob/guardrails/test_x.py');
  });

  assert.equal(readFileSync(join(projectRoot, PYTEST_INI_FILE), 'utf8'), PYTEST_INI);
});

test('pytest strategy: reads the JUnit XML report from the result file', async () => {
  const projectRoot = tmpProject();
  const xml = '<?xml version="1.0"?><testsuites/>';
  const fakeBin = fakeBinDir('python3', `mkdir -p .unitbob/guardrails; printf '${xml}' > ${PYTEST_RESULT_FILE}`);

  await withPath(fakeBin, async () => {
    const result = await runPytestSuite(projectRoot, '.unitbob/guardrails/test_x.py');
    assert.equal(result.report, xml);
  });
});
