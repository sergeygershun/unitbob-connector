import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeBehavioralWorld } from '../src/runner/worldProbe.ts';

test('the World probe executes three scenarios and checks request, mocks, assertions, state cleanup and the network block', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-world-probe-'));
  let feature = '';
  let steps = '';
  const result = await probeBehavioralWorld(projectRoot, {
    runCmd: async (command, args, options) => {
      assert.equal(command, 'bundle');
      assert.deepEqual(args.slice(0, 2), ['exec', 'cucumber']);
      // Every path in the command is relative to the project root — that is what
      // lets the same command run in a container (spec 36, §4.2) — so the test
      // rejoins them here, exactly as the working directory would.
      assert.equal(args[2].startsWith('/'), false);
      feature = readFileSync(join(projectRoot, args[2]), 'utf8');
      steps = readFileSync(join(projectRoot, args[args.indexOf('--require', 5) + 1]), 'utf8');
      assert.equal(options.env.RAILS_ENV, 'test');
      assert.equal(options.env.CUCUMBER_PUBLISH_QUIET, 'true');
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal((feature.match(/Scenario:/g) ?? []).length, 3);
  // Spec 35-1, criterion 2. Proved on the user's own project rather than assumed
  // from the World file's source: a suite whose WebMock never came on passes
  // exactly like one where it did, and only the far end of the wire finds out.
  assert.match(steps, /WebMock::NetConnectNotAllowedError/);
  assert.match(steps, /unitbob_expect_status/);
  assert.match(steps, /unitbob_expect_redirect_to/);
  assert.match(steps, /PROBE_RECEIVER/);
  assert.match(steps, /not_to respond_to\(:unitbob_probe\)/);
  assert.match(steps, /schema_migrations/);
  assert.match(steps, /Time\.zone|I18n\.locale/);
  assert.match(steps, /Rails\.application\.routes\.draw/);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'suite-build', 'world-probe')), false);
});

test('the World probe reports scenario output instead of hiding it behind stderr noise', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-world-probe-output-'));
  const result = await probeBehavioralWorld(projectRoot, {
    runCmd: async () => ({
      code: 1,
      stdout: 'No route matches [GET] "/__unitbob_world_probe__"',
      stderr: 'Share your Cucumber Report with your team',
    }),
  });

  assert.equal(result.status, 'fixable');
  assert.match(result.message ?? '', /No route matches/);
});

test('the World probe returns an exact fixable runner failure', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-world-probe-fail-'));
  const result = await probeBehavioralWorld(projectRoot, {
    runCmd: async () => ({ code: 1, stdout: '', stderr: 'undefined method assertions' }),
  });

  assert.equal(result.status, 'fixable');
  assert.match(result.message ?? '', /undefined method assertions/);
});
