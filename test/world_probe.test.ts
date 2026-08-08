import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeBehavioralWorld } from '../src/runner/worldProbe.ts';

test('the World probe executes two scenarios and checks request, mocks, assertions and state cleanup', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-world-probe-'));
  let feature = '';
  let steps = '';
  const result = await probeBehavioralWorld(projectRoot, {
    runCmd: async (command, args, options) => {
      assert.equal(command, 'bundle');
      assert.deepEqual(args.slice(0, 2), ['exec', 'cucumber']);
      feature = readFileSync(args[2], 'utf8');
      steps = readFileSync(args[args.indexOf('--require', 5) + 1], 'utf8');
      assert.equal(options.env.RAILS_ENV, 'test');
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal((feature.match(/Scenario:/g) ?? []).length, 2);
  assert.match(steps, /unitbob_expect_status/);
  assert.match(steps, /unitbob_expect_redirect_to/);
  assert.match(steps, /PROBE_RECEIVER/);
  assert.match(steps, /not_to respond_to\(:unitbob_probe\)/);
  assert.match(steps, /schema_migrations/);
  assert.match(steps, /Time\.zone|I18n\.locale/);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'suite-build', 'world-probe')), false);
});

test('the World probe returns an exact fixable runner failure', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-world-probe-fail-'));
  const result = await probeBehavioralWorld(projectRoot, {
    runCmd: async () => ({ code: 1, stdout: '', stderr: 'undefined method assertions' }),
  });

  assert.equal(result.status, 'fixable');
  assert.match(result.message ?? '', /undefined method assertions/);
});
