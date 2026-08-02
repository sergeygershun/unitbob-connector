import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootCheck, testDatabaseIsSeparate, type BootCheckDeps } from '../src/runner/bootcheck.ts';
import { UNITBOB_HELPER_RB } from '../src/files/guardrails.ts';

// Spec 32-6 Phase 1. The question this module answers is narrow on purpose:
// not "is the app healthy" but "would the suite get off the ground". These
// tests hold it to that line — in particular they pin the cases where the
// honest answer is "we did not check", because treating those as "broken"
// would block projects that are perfectly fine.

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-bootcheck-'));
}

function railsProject(): string {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'structural'), { recursive: true });
  writeFileSync(join(projectRoot, '.unitbob', 'structural', 'unitbob_helper.rb'), UNITBOB_HELPER_RB);
  return projectRoot;
}

function vitestProject(): string {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(projectRoot, 'node_modules', '.bin', 'vitest'), '');
  return projectRoot;
}

// One canned process result, and a record of what was asked to run.
function fakeRunner(
  results: { code: number | null; stdout?: string; stderr?: string }[],
): BootCheckDeps & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    runCmd: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      const next = results[Math.min(index, results.length - 1)];
      index += 1;
      return { code: next.code, stdout: next.stdout ?? '', stderr: next.stderr ?? '' };
    },
  };
}

test('rspec: the helper loads cleanly, so the suite can start', async () => {
  const deps = fakeRunner([{ code: 0 }]);
  const result = await bootCheck(railsProject(), 'rspec', deps);

  assert.deepEqual(result, { status: 'ok' });
  // It loads the very file the generated spec requires first — not a stand-in.
  assert.match(deps.calls[0], /exec ruby -e require .*unitbob_helper\.rb/);
});

test('rspec: a failed load is broken, and quotes the runner word for word', async () => {
  const stderr =
    "/app/models/report.rb:1:in `<main>': undefined method `before_validation' for main:Object (NoMethodError)";
  const result = await bootCheck(railsProject(), 'rspec', fakeRunner([{ code: 1, stderr }]));

  assert.equal(result.status, 'broken');
  if (result.status !== 'broken') return;
  // Verbatim, including the file and line the runner chose to print. A
  // paraphrase would be a string the vibecoder cannot search for.
  assert.equal(result.message, stderr);
  assert.match(result.detail, /report\.rb/);
});

test('a project frame plus a real error reads as a defect in the code', async () => {
  const stderr = "/app/models/report.rb:1:in `<main>': undefined method `before_validation' (NoMethodError)";
  const result = await bootCheck(railsProject(), 'rspec', fakeRunner([{ code: 1, stderr }]));

  assert.equal(result.status === 'broken' && result.cause, 'defect_in_code');
});

test('a missing gem reads as environment, not as a defect', async () => {
  const stderr = 'bundler: failed to load command: rspec\nBundler::GemNotFound: Could not find rake-13.0.6';
  const result = await bootCheck(railsProject(), 'rspec', fakeRunner([{ code: 1, stderr }]));

  assert.equal(result.status === 'broken' && result.cause, 'environment_not_ready');
});

// The half a Rails-shaped reading misses. Ruby resolves gems before the first
// application file, so "missing dependency" there never has a project frame.
// Python and JS resolve the import from inside a project file, so the frame is
// present and the rule "project frame means defect" would call an un-run
// `pip install` a bug in the user's code.
test('a missing module inside a project file is still environment, not a defect', async () => {
  const stdout = [
    'tests/test_foo.py:3: in <module>',
    '    import requests',
    "E   ModuleNotFoundError: No module named 'requests'",
  ].join('\n');
  const result = await bootCheck(tmpProject(), 'pytest', fakeRunner([{ code: 2, stdout }]));

  assert.equal(result.status === 'broken' && result.cause, 'environment_not_ready');
});

test('pytest: collection succeeds, so the suite can start', async () => {
  const deps = fakeRunner([{ code: 0 }]);
  const result = await bootCheck(tmpProject(), 'pytest', deps);

  assert.deepEqual(result, { status: 'ok' });
  assert.match(deps.calls[0], /-m pytest --collect-only -q/);
});

test('pytest: an import error in collected code is broken', async () => {
  const stdout = 'app/billing.py:2: in <module>\nE   SyntaxError: invalid syntax';
  const result = await bootCheck(tmpProject(), 'pytest', fakeRunner([{ code: 2, stdout }]));

  assert.equal(result.status, 'broken');
});

// pytest exits 5 when it collected nothing. A project that came to Unitbob to
// get tests written is the typical customer, not a broken app — calling this
// `broken` would refuse exactly the people the product is for.
test('pytest: no tests to collect is not checked, not broken', async () => {
  const result = await bootCheck(tmpProject(), 'pytest', fakeRunner([{ code: 5, stdout: 'no tests ran' }]));

  assert.deepEqual(result, { status: 'not_checked', reason: 'nothing_to_load' });
});

test('vitest: listing the test files succeeds', async () => {
  const deps = fakeRunner([{ code: 0 }]);
  const result = await bootCheck(vitestProject(), 'vitest', deps);

  assert.deepEqual(result, { status: 'ok' });
  assert.match(deps.calls[0], /vitest list$/);
});

test('vitest: a project with no test files is not checked, not broken', async () => {
  const result = await bootCheck(
    vitestProject(),
    'vitest',
    fakeRunner([{ code: 1, stderr: 'No test files found, exiting with code 1' }]),
  );

  assert.deepEqual(result, { status: 'not_checked', reason: 'nothing_to_load' });
});

test('vitest: an unparseable test file is broken', async () => {
  const result = await bootCheck(
    vitestProject(),
    'vitest',
    fakeRunner([{ code: 1, stderr: 'Error: Transform failed with 1 error:\nsrc/cart.ts:4:2: ERROR: Expected ")"' }]),
  );

  assert.equal(result.status, 'broken');
  assert.equal(result.status === 'broken' && result.cause, 'defect_in_code');
});

// Nothing to load with is not the same as nothing loading. Each of these three
// leaves us without an answer, and none of them may read as a verdict on the
// code.
test('no runner at all is not checked', async () => {
  assert.deepEqual(await bootCheck(tmpProject(), null, fakeRunner([{ code: 0 }])), {
    status: 'not_checked',
    reason: 'no_runner',
  });
});

test('vitest that is not installed is not checked — and is never installed to find out', async () => {
  const deps = fakeRunner([{ code: 0 }]);
  const result = await bootCheck(tmpProject(), 'vitest', deps);

  assert.deepEqual(result, { status: 'not_checked', reason: 'no_runner' });
  // Reaching for npx would install a package into the user's project to answer
  // a question. Nothing ran at all.
  assert.deepEqual(deps.calls, []);
});

test('a missing boot helper is nothing to load, not a broken app', async () => {
  assert.deepEqual(await bootCheck(tmpProject(), 'rspec', fakeRunner([{ code: 0 }])), {
    status: 'not_checked',
    reason: 'nothing_to_load',
  });
});

// runProcess reports a timeout as a null exit code. Waiting too long says
// nothing about the code, so it must not come back as a defect.
test('a load that runs past the limit is not checked, not broken', async () => {
  assert.deepEqual(await bootCheck(railsProject(), 'rspec', fakeRunner([{ code: null }])), {
    status: 'not_checked',
    reason: 'timed_out',
  });
});

// --- Task 1.2: repair what we may, then ask once more --------------------

function withDatabaseYml(projectRoot: string, body: string): string {
  mkdirSync(join(projectRoot, 'config'), { recursive: true });
  writeFileSync(join(projectRoot, 'config', 'database.yml'), body);
  return projectRoot;
}

const SEPARATE_DATABASES = `development:
  adapter: postgresql
  database: shop_development

test:
  adapter: postgresql
  database: shop_test
`;

const SHARED_DATABASE = `development:
  adapter: postgresql
  database: shop

test:
  adapter: postgresql
  database: shop
`;

test('a failed load is retried once after the test database is prepared', async () => {
  const projectRoot = withDatabaseYml(railsProject(), SEPARATE_DATABASES);
  const deps = fakeRunner([
    { code: 1, stderr: 'ActiveRecord::NoDatabaseError: database "shop_test" does not exist' },
    { code: 0 }, // db:test:prepare
    { code: 0 }, // the retry
  ]);

  assert.deepEqual(await bootCheck(projectRoot, 'rspec', deps), { status: 'ok' });
  assert.match(deps.calls[1], /db:test:prepare/);
  // Once, not in a loop: load, prepare, load. Then the answer stands.
  assert.equal(deps.calls.length, 3);
});

// The one place where being wrong destroys something a re-run cannot restore.
// Every uncertainty resolves to "don't".
test('db:test:prepare is skipped when test and development name the same database', async () => {
  const projectRoot = withDatabaseYml(railsProject(), SHARED_DATABASE);
  const deps = fakeRunner([{ code: 1, stderr: 'ActiveRecord::NoDatabaseError' }]);

  const result = await bootCheck(projectRoot, 'rspec', deps);

  assert.equal(result.status, 'broken');
  assert.equal(deps.calls.length, 1, 'the load was attempted once and nothing was prepared');
  assert.ok(!deps.calls.some((call) => call.includes('db:test:prepare')));
});

test('a database.yml we cannot read two names out of stops the repair', () => {
  // Inherited through an anchor: we cannot resolve it, so we do not act on it.
  assert.equal(
    testDatabaseIsSeparate(
      withDatabaseYml(tmpProject(), 'default: &default\n  database: shop\n\ntest:\n  <<: *default\n'),
    ),
    false,
  );
  // No database.yml at all.
  assert.equal(testDatabaseIsSeparate(tmpProject()), false);
  // Two names we can read, and they differ.
  assert.equal(testDatabaseIsSeparate(withDatabaseYml(tmpProject(), SEPARATE_DATABASES)), true);
});

// The project's own dependencies rewrite Gemfile.lock and package-lock.json,
// which are the user's files — outside the sandbox rule that lets us write a
// sidecar Gemfile and a test database. They are named to the human instead.
test('the project\'s own dependencies are never installed', async () => {
  const projectRoot = withDatabaseYml(railsProject(), SEPARATE_DATABASES);
  const deps = fakeRunner([{ code: 1, stderr: 'Bundler::GemNotFound: Could not find rake-13.0.6' }, { code: 0 }, { code: 1, stderr: 'Bundler::GemNotFound' }]);

  await bootCheck(projectRoot, 'rspec', deps);

  for (const call of deps.calls) {
    assert.ok(!/bundle install|npm install|pip install/.test(call), `installed dependencies: ${call}`);
  }
});

// --- Task 1.0 regression -------------------------------------------------

// Observed by hand on a2time (2026-08-02) with the broken `report.rb` still in
// place: `unitbob_helper.rb` loads, and the suite goes on to run 80 examples
// with 56 of them green. The spec had assumed the opposite, and the assumption
// is what this test pins: a load that succeeds is `ok` even when the project
// contains a defect that will fail tests later. Answering `broken` here would
// take away a suite that builds and correctly reports what is wrong.
test('a project whose suite starts is ok, even with a defect waiting inside it', async () => {
  const result = await bootCheck(railsProject(), 'rspec', fakeRunner([{ code: 0 }]));

  assert.deepEqual(result, { status: 'ok' });
});
