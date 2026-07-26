// The connector-owned BDD strategies (spec 32): one runner per stack, the raw
// report read back from the file the runner wrote, and the pytest-bdd reporter
// plugin the connector ships. Host-provided command strings are never executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { runBddSuite } from '../src/runner/bdd.ts';
import { PYTEST_BDD_PLUGIN } from '../src/runner/pytestBddPlugin.ts';

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-bdd-'));
  mkdirSync(join(dir, '.unitbob', 'behavioral', 'features'), { recursive: true });
  mkdirSync(join(dir, '.unitbob', 'behavioral', 'step_definitions'), { recursive: true });
  return dir;
}

function fakeBinDir(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-fake-bin-'));
  writeExecutable(join(dir, name), body);
  return dir;
}

function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
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

test('cucumber strategy reads the Cucumber Messages report the runner wrote', async () => {
  const projectRoot = tmpProject();
  const report = '{"testCaseStarted":{"id":"s1"}}';
  writeFileSync(join(projectRoot, '.unitbob', 'behavioral', 'Gemfile'), 'gem "cucumber"\n');
  const fakeBin = fakeBinDir(
    'bundle',
    `test "$BUNDLE_GEMFILE" = ".unitbob/behavioral/Gemfile" || exit 4\nmkdir -p .unitbob/behavioral; printf '${report}' > .unitbob/behavioral/cucumber_messages.ndjson`,
  );

  await withPath(fakeBin, async () => {
    const result = await runBddSuite(projectRoot, 'cucumber', '.unitbob/behavioral/features/surface_contracts.feature');
    assert.equal(result.report, report);
    assert.equal(result.resultPath, '.unitbob/behavioral/cucumber_messages.ndjson');
    assert.deepEqual(result.args.slice(0, 2), ['exec', 'cucumber']);
  });
});

test('cucumber strategy reports a missing sidecar instead of falling back to the project bundle', async () => {
  await assert.rejects(
    () => runBddSuite(tmpProject(), 'cucumber', '.unitbob/behavioral/features/surface_contracts.feature'),
    /Behavioral runner missing.*suite-prepare/,
  );
});

test('cucumber-js strategy runs the provisioned sidecar with the message formatter', async () => {
  const projectRoot = tmpProject();
  const report = '{"testCaseStarted":{"id":"s2"}}';
  const sidecarBin = join(projectRoot, '.unitbob', 'behavioral', 'node_modules', '.bin', 'cucumber-js');
  writeExecutable(sidecarBin, `mkdir -p .unitbob/behavioral; printf '${report}' > .unitbob/behavioral/cucumber_messages.ndjson`);

  const result = await runBddSuite(projectRoot, 'cucumber-js', '.unitbob/behavioral/features/surface_contracts.feature');
  assert.equal(result.command, sidecarBin);
  assert.equal(result.report, report);
  assert.ok(result.args.some((arg) => arg.startsWith('message:')), 'uses the message formatter to a file');
});

test('cucumber-js strategy reports a missing sidecar instead of invoking npx', async () => {
  await assert.rejects(
    () => runBddSuite(tmpProject(), 'cucumber-js', '.unitbob/behavioral/features/surface_contracts.feature'),
    /Behavioral runner missing.*suite-prepare/,
  );
});

test('pytest-bdd strategy writes its ini + plugin and reads the connector report', async () => {
  const projectRoot = tmpProject();
  const report = '{"version":1,"scenarios":[]}';
  const sidecarPytest = join(projectRoot, '.unitbob', 'behavioral', '.venv', 'bin', 'pytest');
  writeExecutable(sidecarPytest, `printf '%s' '${report}' > "$UNITBOB_PYTEST_BDD_REPORT"`);

  const result = await runBddSuite(projectRoot, 'pytest-bdd', '.unitbob/behavioral/features/surface_contracts.feature');
  assert.equal(result.command, sidecarPytest);
  assert.equal(result.report, report);
  assert.equal(result.resultPath, '.unitbob/behavioral/pytest_bdd_report.json');
});

test('pytest-bdd strategy reports a missing sidecar instead of using system pytest', async () => {
  await assert.rejects(
    () => runBddSuite(tmpProject(), 'pytest-bdd', '.unitbob/behavioral/features/surface_contracts.feature'),
    /Behavioral runner missing.*suite-prepare/,
  );
});

test('an unknown BDD runner is rejected, never guessed', async () => {
  await assert.rejects(() => runBddSuite(tmpProject(), 'behave', 'x.feature'), /Unsupported BDD runner/);
});

test('the pytest-bdd plugin hangs off the public pytest-bdd hooks and writes JSON', () => {
  for (const hook of [
    'pytest_bdd_before_scenario',
    'pytest_bdd_after_step',
    'pytest_bdd_step_error',
    'pytest_bdd_after_scenario',
  ]) {
    assert.match(PYTEST_BDD_PLUGIN, new RegExp(`def ${hook}\\(`));
  }
  assert.match(PYTEST_BDD_PLUGIN, /json\.dump/);
  assert.match(PYTEST_BDD_PLUGIN, /UNITBOB_PYTEST_BDD_REPORT/);
});
