import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runRspecExample, runRspecSuite } from '../src/runner/rspec.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-rspec-'));
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

test('uses executable bin/rspec first with the exact suite path and env root', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'bin'), { recursive: true });
  executable(
    join(projectRoot, 'bin', 'rspec'),
    'printf \'{"args":"%s","root":"%s","pwd":"%s"}\' "$*" "$UNITBOB_REPO_ROOT" "$(pwd)"',
  );

  const result = await runRspecSuite(projectRoot);
  const payload = JSON.parse(result.stdout);

  assert.equal(result.command, join(projectRoot, 'bin', 'rspec'));
  assert.deepEqual(result.args, ['.unitbob/guardrails/architecture_map_contracts_spec.rb', '--format', 'json']);
  assert.equal(payload.args, '.unitbob/guardrails/architecture_map_contracts_spec.rb --format json');
  assert.equal(payload.root, projectRoot);
  assert.equal(realpathSync(payload.pwd), realpathSync(projectRoot));
});

test('runRspecExample points at the given spec and filters to the one example (spec 21 gate)', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'bin'), { recursive: true });
  executable(
    join(projectRoot, 'bin', 'rspec'),
    'printf \'{"args":"%s","root":"%s"}\' "$*" "$UNITBOB_REPO_ROOT"',
  );

  const result = await runRspecExample(projectRoot, '.unitbob/reshape/candidate_spec.rb', 'amg_t_interface_charge_001');
  const payload = JSON.parse(result.stdout);

  assert.deepEqual(result.args, [
    '.unitbob/reshape/candidate_spec.rb',
    '-e',
    '[amg_t_interface_charge_001]',
    '--format',
    'json',
  ]);
  assert.equal(payload.root, projectRoot);
});

test('falls back to bundle exec rspec when bin/rspec is not executable', async () => {
  const projectRoot = tmpProject();
  const fakeBin = mkdtempSync(join(tmpdir(), 'unitbob-bundle-'));
  executable(
    join(fakeBin, 'bundle'),
    'printf \'{"args":"%s","root":"%s"}\' "$*" "$UNITBOB_REPO_ROOT"',
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${delimiter}${oldPath ?? ''}`;

  try {
    const result = await runRspecSuite(projectRoot);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.command, 'bundle');
    assert.deepEqual(result.args, ['exec', 'rspec', '.unitbob/guardrails/architecture_map_contracts_spec.rb', '--format', 'json']);
    assert.equal(payload.args, 'exec rspec .unitbob/guardrails/architecture_map_contracts_spec.rb --format json');
    assert.equal(payload.root, projectRoot);
  } finally {
    process.env.PATH = oldPath;
  }
});
