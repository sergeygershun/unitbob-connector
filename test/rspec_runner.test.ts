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

  const result = await runRspecSuite(projectRoot, ['.unitbob/structural/architecture_map_contracts_spec.rb']);
  const payload = JSON.parse(result.stdout);

  // The binstub is named relative to the project root, and the slash is what
  // makes it resolve there instead of on PATH (spec 36, §4.2). That the fake
  // binstub is the thing that answered is proved by the payload below.
  assert.equal(result.command, 'bin/rspec');
  assert.deepEqual(result.args, [
    '.unitbob/structural/architecture_map_contracts_spec.rb',
    '--options',
    '.unitbob/structural/rspec.opts',
    '--order',
    'defined',
    '--seed',
    '1',
    '--format',
    'json',
    '--out',
    '.unitbob/structural/rspec_result.json',
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
    const result = await runRspecSuite(projectRoot, ['.unitbob/structural/architecture_map_contracts_spec.rb']);
    const payload = JSON.parse(result.stdout);

    assert.equal(result.command, 'bundle');
    assert.deepEqual(result.args, [
      'exec',
      'rspec',
      '.unitbob/structural/architecture_map_contracts_spec.rb',
      '--options',
      '.unitbob/structural/rspec.opts',
      '--order',
      'defined',
      '--seed',
      '1',
      '--format',
      'json',
      '--out',
      '.unitbob/structural/rspec_result.json',
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
    'mkdir -p .unitbob/structural; printf \'{"examples":[]}\' > .unitbob/structural/rspec_result.json; printf \'DEPRECATION WARNING: noise\'',
  );

  const result = await runRspecSuite(projectRoot, ['.unitbob/structural/architecture_map_contracts_spec.rb']);

  assert.deepEqual(JSON.parse(result.report), { examples: [] });
  assert.match(result.stdout, /DEPRECATION WARNING/);
});

// Spec 36, criterion 9. The report goes to a fixed path with no run marker on
// it, and — once the run happens in a container — into a folder both sides
// share. A run we gave up on can leave a process alive in there that writes the
// report after we stopped waiting, and the next run would read it as its own:
// a green result nobody earned. Having none is the better of the two.
test('a report left over from an earlier run is not counted as this run\'s', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'bin'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'structural'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.unitbob', 'structural', 'rspec_result.json'),
    '{"examples":[{"status":"passed"}]}',
  );
  // This one dies before writing anything, exactly as a suite that cannot boot
  // does.
  executable(join(projectRoot, 'bin', 'rspec'), 'exit 1');

  const result = await runRspecSuite(projectRoot, ['.unitbob/structural/architecture_map_contracts_spec.rb']);

  assert.equal(result.report, '');
});
