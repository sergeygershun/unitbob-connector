import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runRspecSuite } from '../src/runner/rspec.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-rspec-'));
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

test('uses executable bin/rspec first with the exact suite path, fixed order/seed, and test env', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'bin'), { recursive: true });
  executable(
    join(projectRoot, 'bin', 'rspec'),
    'printf \'{"args":"%s","root":"%s","rails_env":"%s","pwd":"%s"}\' "$*" "$UNITBOB_REPO_ROOT" "$RAILS_ENV" "$(pwd)"',
  );

  const result = await runRspecSuite(projectRoot, '.unitbob/guardrails/architecture_map_contracts_spec.rb');
  const payload = JSON.parse(result.stdout);

  assert.equal(result.command, join(projectRoot, 'bin', 'rspec'));
  assert.deepEqual(result.args, [
    '.unitbob/guardrails/architecture_map_contracts_spec.rb',
    '--options',
    '.unitbob/guardrails/rspec.opts',
    '--order',
    'defined',
    '--seed',
    '1',
    '--format',
    'json',
    '--out',
    '.unitbob/guardrails/rspec_result.json',
  ]);
  assert.equal(payload.root, projectRoot);
  assert.equal(payload.rails_env, 'test');
  assert.equal(realpathSync(payload.pwd), realpathSync(projectRoot));
});

test('falls back to bundle exec rspec when bin/rspec is not executable', async () => {
  const projectRoot = tmpProject();
  const fakeBin = mkdtempSync(join(tmpdir(), 'unitbob-bundle-'));
  executable(
    join(fakeBin, 'bundle'),
    'printf \'{"args":"%s","root":"%s","rails_env":"%s"}\' "$*" "$UNITBOB_REPO_ROOT" "$RAILS_ENV"',
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${delimiter}${oldPath ?? ''}`;

  try {
    const result = await runRspecSuite(projectRoot, '.unitbob/guardrails/architecture_map_contracts_spec.rb');
    const payload = JSON.parse(result.stdout);

    assert.equal(result.command, 'bundle');
    assert.deepEqual(result.args, [
      'exec',
      'rspec',
      '.unitbob/guardrails/architecture_map_contracts_spec.rb',
      '--options',
      '.unitbob/guardrails/rspec.opts',
      '--order',
      'defined',
      '--seed',
      '1',
      '--format',
      'json',
      '--out',
      '.unitbob/guardrails/rspec_result.json',
    ]);
    assert.equal(payload.root, projectRoot);
    assert.equal(payload.rails_env, 'test');
  } finally {
    process.env.PATH = oldPath;
  }
});

test('reads the JSON report from the --out file, immune to stdout pollution', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'bin'), { recursive: true });
  // The fake writes the report to the --out path and prints unrelated noise to
  // stdout — exactly the shape (a passing run + app stdout writes) that used to
  // be misreported as a suite error.
  executable(
    join(projectRoot, 'bin', 'rspec'),
    'mkdir -p .unitbob/guardrails; printf \'{"examples":[]}\' > .unitbob/guardrails/rspec_result.json; printf \'DEPRECATION WARNING: noise\'',
  );

  const result = await runRspecSuite(projectRoot, '.unitbob/guardrails/architecture_map_contracts_spec.rb');

  assert.deepEqual(JSON.parse(result.report), { examples: [] });
  assert.match(result.stdout, /DEPRECATION WARNING/);
});
