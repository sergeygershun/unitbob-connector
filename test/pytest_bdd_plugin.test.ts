// The connector-owned pytest-bdd reporter, driven the way pytest-bdd drives it
// (spec 32; spec 52-3, AC 3.7). The plugin is plain Python with no pytest
// import, so the hooks are called here from a small driver with stand-ins for
// pytest-bdd's objects, and the report it writes is read back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PYTEST_BDD_PLUGIN } from '../src/runner/pytestBddPlugin.ts';

const DRIVER = `
import os, sys
sys.path.insert(0, os.getcwd())
import unitbob_pytest_bdd_plugin as plugin

class Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)

feature = Obj(rel_filename="features/f.feature")
step_given = Obj(keyword="Given ", name="a post")
step_when = Obj(keyword="When ", name="the reader comments")

# One scenario whose second step has no definition: pytest-bdd calls the
# lookup-error hook, raises, and still runs after_scenario in its finally.
missing = Obj(name="A reader comments", tags={"ubc_0123456789ab", "unitbob_feature_7"})
plugin.pytest_bdd_before_scenario(None, feature, missing)
plugin.pytest_bdd_after_step(None, feature, missing, step_given, None)
plugin.pytest_bdd_step_func_lookup_error(None, feature, missing, step_when, Exception("Step definition is not found: When \\"the reader comments\\""))
plugin.pytest_bdd_after_scenario(None, feature, missing)

# And one that fails on an assertion, as before.
failing = Obj(name="A guest cannot comment", tags={"ubc_0123456789ab"})
plugin.pytest_bdd_before_scenario(None, feature, failing)
plugin.pytest_bdd_step_error(None, feature, failing, step_given, None, None, AssertionError("no post"))
plugin.pytest_bdd_after_scenario(None, feature, failing)

plugin.pytest_sessionfinish(None, 1)
`;

function runPlugin(): { scenarios: { name: string; status: string; failure: string; steps: { keyword: string; text: string; status: string }[] }[] } {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-pytest-bdd-plugin-'));
  writeFileSync(join(dir, 'unitbob_pytest_bdd_plugin.py'), PYTEST_BDD_PLUGIN);
  writeFileSync(join(dir, 'driver.py'), DRIVER);
  const report = join(dir, 'report.json');
  const run = spawnSync('python3', ['driver.py'], { cwd: dir, env: { ...process.env, UNITBOB_PYTEST_BDD_REPORT: report }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(readFileSync(report, 'utf8'));
}

test('an undefined step is recorded as undefined and fails its scenario with the lookup error', () => {
  const { scenarios } = runPlugin();
  const missing = scenarios.find((s) => s.name === 'A reader comments');
  assert.ok(missing);
  assert.equal(missing.status, 'failed');
  assert.match(missing.failure, /^Exception: Step definition is not found/);
  assert.deepEqual(missing.steps, [
    { keyword: 'Given', text: 'a post', status: 'passed' },
    { keyword: 'When', text: 'the reader comments', status: 'undefined' },
  ]);
});

test('a step that raises is still recorded as failed with its error', () => {
  const { scenarios } = runPlugin();
  const failing = scenarios.find((s) => s.name === 'A guest cannot comment');
  assert.ok(failing);
  assert.equal(failing.status, 'failed');
  assert.equal(failing.failure, 'AssertionError: no post');
  assert.deepEqual(failing.steps, [{ keyword: 'Given', text: 'a post', status: 'failed' }]);
});
