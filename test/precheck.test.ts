import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anyStackPrecheck,
  behavioralHarnessNotice,
  runnerReadyPrecheck,
  validateStack,
  type PrecheckDeps,
} from '../src/runner/precheck.ts';
import { SIDECAR_DIR } from '../src/runner/toolchain.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-precheck-'));
}

const pytestPresent: PrecheckDeps = { commandSucceeds: () => true };
const pytestMissing: PrecheckDeps = { commandSucceeds: () => false };

function rubyProject(gemfile: string): string {
  const dir = tmpProject();
  writeFileSync(join(dir, 'Gemfile'), gemfile);
  return dir;
}

test('rspec: passes on Rails + rspec-rails without any spec/rails_helper.rb (spec 29)', () => {
  const dir = rubyProject("gem 'rails'\ngem 'rspec-rails'\n");
  assert.deepEqual(validateStack(dir, 'rspec'), { ok: true });
});

test('rspec: fails without the rails gem', () => {
  const check = validateStack(rubyProject("gem 'sinatra'\n"), 'rspec');
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /no `rails` gem found in Gemfile/);
});

test('rspec: missing rspec-rails instructs the agent to offer the gem, with consent', () => {
  const check = validateStack(rubyProject("gem 'rails'\n"), 'rspec');
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /need the rspec-rails gem/);
  assert.match(check.message ?? '', /Offer the user to add it and run `bundle install`/);
  assert.match(check.message ?? '', /only with their consent, then retry/);
});

test('rspec: a bare rspec gem is not enough — the boot helper needs rspec-rails', () => {
  const check = validateStack(rubyProject("gem 'rails'\ngem 'rspec'\n"), 'rspec');
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /need the rspec-rails gem/);
});

test('vitest: passes when package.json names vitest', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3.0.0' } }));
  assert.deepEqual(validateStack(dir, 'vitest'), { ok: true });
});

test('vitest: passes when node_modules/.bin/vitest exists even if package.json does not name it', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', '.bin', 'vitest'), '#!/bin/sh\n');
  assert.deepEqual(validateStack(dir, 'vitest'), { ok: true });
});

test('vitest: fails without package.json (stack mismatch, fail closed)', () => {
  const check = validateStack(tmpProject(), 'vitest');
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /no package\.json/);
});

test('vitest: a Jest-only project is refused — MVP v2 requires Vitest', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { jest: '^29.0.0' } }));
  const check = validateStack(dir, 'vitest');
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /require Vitest/);
  assert.match(check.message ?? '', /Jest is not supported/);
});

test('pytest: passes with a Python project marker when pytest is importable', () => {
  for (const marker of ['pyproject.toml', 'requirements.txt', 'Pipfile']) {
    const dir = tmpProject();
    writeFileSync(join(dir, marker), '');
    assert.deepEqual(validateStack(dir, 'pytest', pytestPresent), { ok: true }, marker);
  }
});

test('pytest: fails closed when the markers are present but pytest is not importable', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, 'pyproject.toml'), '');
  const check = validateStack(dir, 'pytest', pytestMissing);
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /pytest is not importable/);
  assert.match(check.message ?? '', /virtualenv/);
});

test('pytest: fails without Python project markers', () => {
  const check = validateStack(tmpProject(), 'pytest', pytestPresent);
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /does not look like a Python project/);
});

test('an unknown runner is refused', () => {
  const check = validateStack(tmpProject(), 'jest');
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /Unsupported runner "jest"/);
});

// The behavioral (Gherkin) runners (spec 32) confirm only the base language —
// check installs nothing, so a missing BDD runner is left to surface as a suite
// error from the run. rspec-rails / vitest presence is not required here.
test('cucumber: passes on a Rails project, without requiring rspec-rails or the cucumber gem', () => {
  assert.deepEqual(validateStack(rubyProject("gem 'rails'\n"), 'cucumber'), { ok: true });
});

test('cucumber: fails with a clear message when the project is not Ruby', () => {
  const check = validateStack(rubyProject("gem 'sinatra'\n"), 'cucumber');
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /behavioral \(Gherkin\) suite selected the Ruby stack/);
  assert.match(check.message ?? '', /does not look like Rails/);
});

test('cucumber-js: passes when a package.json is present', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, 'package.json'), '{}');
  assert.deepEqual(validateStack(dir, 'cucumber-js'), { ok: true });
});

test('cucumber-js: fails with a clear message when there is no package.json', () => {
  const check = validateStack(tmpProject(), 'cucumber-js');
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /JavaScript\/TypeScript stack, but this project has no package.json/);
});

test('pytest-bdd: passes with a Python marker when pytest is importable', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, 'pyproject.toml'), '');
  assert.deepEqual(validateStack(dir, 'pytest-bdd', pytestPresent), { ok: true });
});

test('pytest-bdd: fails closed when pytest is not importable', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, 'requirements.txt'), '');
  const check = validateStack(dir, 'pytest-bdd', pytestMissing);
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /pytest is not importable/);
});

test('pytest-bdd: fails without Python project markers', () => {
  const check = validateStack(tmpProject(), 'pytest-bdd', pytestPresent);
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /does not look like a Python project/);
});

test('anyStackPrecheck passes when at least one stack matches and fails when none do', () => {
  const python = tmpProject();
  writeFileSync(join(python, 'pyproject.toml'), '');
  assert.equal(anyStackPrecheck(python, pytestPresent).ok, true);

  const empty = anyStackPrecheck(tmpProject(), pytestPresent);
  assert.equal(empty.ok, false);
  assert.match(empty.message ?? '', /matches none of those stacks/);
});

// The bug that these three tests exist for, found on a Flask project on
// 2026-08-11. It had a requirements.txt and no pytest installed, and the gate
// answered "This project matches none of those stacks" — which is false: it is
// a Python project, it simply had no runner yet. The specific, actionable
// message was written a few lines below in `pytestPrecheck` and thrown away by
// the caller, so the person was sent to look for a problem with their project.
//
// Detection now answers only "which language", and the missing runner is
// installed under `.unitbob/` instead of being reported as a dead end. The three
// stacks are tested together because the defect was never Python's: a Rails app
// without rspec-rails and a package.json without vitest got the same false
// sentence.
test('a Python project with no pytest is still a Python project', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, 'requirements.txt'), 'flask\n');

  const check = anyStackPrecheck(dir, pytestMissing);
  assert.equal(check.ok, true);
  assert.equal(check.runner, 'pytest');
});

test('a Rails project with no rspec-rails is still a Rails project', () => {
  const check = anyStackPrecheck(rubyProject("gem 'rails'\n"), pytestMissing);
  assert.equal(check.ok, true);
  assert.equal(check.runner, 'rspec');
});

test('a JS project with no vitest is still a JS project', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { jest: '^29.0.0' } }));

  const check = anyStackPrecheck(dir, pytestMissing);
  assert.equal(check.ok, true);
  assert.equal(check.runner, 'vitest');
});

test('"none of those stacks" is now said only when it is true', () => {
  const check = anyStackPrecheck(tmpProject(), pytestPresent);
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /matches none of those stacks/);
});

// Detection settles the language; this is the check that the runner is really
// there, run after provisioning and before a whole generation is built on it.
test('pytest: a sidecar interpreter satisfies the runner check', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, 'requirements.txt'), '');
  const venvBin = join(dir, SIDECAR_DIR, '.venv', 'bin');
  mkdirSync(venvBin, { recursive: true });
  writeFileSync(join(venvBin, 'python'), '', { mode: 0o755 });

  // Nothing on the machine can import pytest — only the environment Unitbob
  // built can, and the check asks it the same question it asks any other.
  const onlyTheSidecar: PrecheckDeps = { commandSucceeds: (command) => command.startsWith(venvBin) };
  assert.deepEqual(validateStack(dir, 'pytest', onlyTheSidecar), { ok: true });
  assert.deepEqual(validateStack(dir, 'pytest-bdd', onlyTheSidecar), { ok: true });

  // And an environment that exists but has nothing in it is not an answer: a
  // `bin/python` with no pytest beside it used to pass this check.
  assert.equal(validateStack(dir, 'pytest', pytestMissing).ok, false);
});

// Readiness is asked after provisioning, so it has to know about the
// environment provisioning just built. Asking `validateStack` here refused a
// project seconds after a working runner was installed for it — found on the
// connector's own repository, 2026-08-12.
test('a sidecar runner counts as ready on every stack', () => {
  const js = tmpProject();
  writeFileSync(join(js, 'package.json'), '{}');
  const jsBin = join(js, SIDECAR_DIR, 'node_modules', '.bin');
  mkdirSync(jsBin, { recursive: true });
  writeFileSync(join(jsBin, 'vitest'), '', { mode: 0o755 });
  assert.deepEqual(runnerReadyPrecheck(js, 'vitest', pytestMissing), { ok: true });

  const ruby = rubyProject("gem 'rails'\n");
  mkdirSync(join(ruby, SIDECAR_DIR), { recursive: true });
  writeFileSync(join(ruby, SIDECAR_DIR, 'Gemfile'), 'gem "rspec-rails"\n');
  assert.deepEqual(runnerReadyPrecheck(ruby, 'rspec', pytestMissing), { ok: true });
});

// Spec 43, §5.3. `validateStack` runs on every `run` and `run-local`, long after
// provisioning, and it used to answer the earlier question: does the *project*
// carry this runner. So a project Unitbob had just equipped was told to edit its
// Gemfile or to `npm i -D vitest` — advice for something it now has. The stack
// checks themselves are untouched: a Sinatra project is still not Rails.
test('advice to install a runner is not given to a project that already has one in the sidecar', () => {
  const js = tmpProject();
  writeFileSync(join(js, 'package.json'), '{}');
  assert.equal(validateStack(js, 'vitest', pytestMissing).ok, false);
  const jsBin = join(js, SIDECAR_DIR, 'node_modules', '.bin');
  mkdirSync(jsBin, { recursive: true });
  writeFileSync(join(jsBin, 'vitest'), '', { mode: 0o755 });
  assert.deepEqual(validateStack(js, 'vitest', pytestMissing), { ok: true });

  const ruby = rubyProject("gem 'rails'\n");
  assert.match(validateStack(ruby, 'rspec', pytestMissing).message ?? '', /rspec-rails/);
  mkdirSync(join(ruby, SIDECAR_DIR), { recursive: true });
  writeFileSync(join(ruby, SIDECAR_DIR, 'Gemfile'), 'gem "rspec-rails"\n');

  // The Gemfile alone is not the gem. `provisionRspec` writes it before it runs
  // bundler and leaves it behind when bundler fails, so treating its existence
  // as proof would silence this advice in exactly the case that needs it.
  assert.match(validateStack(ruby, 'rspec', pytestMissing).message ?? '', /rspec-rails/);

  writeFileSync(join(ruby, SIDECAR_DIR, 'Gemfile.lock'), "GEM\n  specs:\n    rspec-rails (6.1.1)\n");
  assert.deepEqual(validateStack(ruby, 'rspec', pytestMissing), { ok: true });

  // A project that is not the stack at all is still refused — the sidecar
  // answers "is the runner here", never "is this the right kind of project".
  assert.equal(validateStack(rubyProject("gem 'sinatra'\n"), 'rspec', pytestMissing).ok, false);
});

test('nothing installed anywhere is refused, naming both places we looked', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, 'package.json'), '{}');

  const check = runnerReadyPrecheck(dir, 'vitest', pytestMissing);
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /not installed in this project/);
  assert.match(check.message ?? '', /could not install one for itself/);
  assert.match(check.message ?? '', /Nothing was written/);
});

// Spec 35-1, criterion 2. The gap this closes was silent by construction:
// Cucumber loads neither `spec/rails_helper.rb` nor `spec/support/**`, so WebMock
// was off and outgoing HTTP left the machine while the structural branch had it
// blocked. Nothing said so, and a worker had no way to know before writing.
test('the behavioral harness notice names what Cucumber does not load, and what the connector stubs', () => {
  const notice = behavioralHarnessNotice('cucumber')!;

  assert.match(notice, /spec\/rails_helper\.rb/);
  assert.match(notice, /spec\/support/);
  assert.match(notice, /WebMock/);
  assert.match(notice, /outgoing HTTP is blocked/);
  assert.match(notice, /Sidekiq/);
  assert.match(notice, /ActiveJob/);
  assert.match(notice, /host/);
});

// Every BDD stack, because none of the three runners reads its project's own
// test bootstrap and all three were reaching the real network in silence. Each
// notice is written in its own runner's terms: one shared sentence would have to
// be vague enough to fit all three, and vague is how the fact went unsaid.
test('the JavaScript branch is told what cucumber-js does not load, in its own terms', () => {
  const notice = behavioralHarnessNotice('cucumber-js')!;

  assert.match(notice, /features\/support/);
  assert.match(notice, /leave this machine is refused/);
  assert.match(notice, /localhost/);
  // No Rails fact leaks across. JavaScript has no project-wide job runner to put
  // in fake mode, and nothing here should imply there is one.
  assert.doesNotMatch(notice, /rails_helper|Sidekiq|ActiveJob|WebMock/);
});

test('the Python branch is told which conftest files pytest loads here, and which it does not', () => {
  const notice = behavioralHarnessNotice('pytest-bdd')!;

  assert.match(notice, /tests\/conftest\.py/);
  assert.match(notice, /step_definitions\/conftest\.py` is untouched/);
  assert.match(notice, /leave this machine is refused/);
  assert.doesNotMatch(notice, /rails_helper|Sidekiq|ActiveJob|WebMock/);
});

// A structural runner has no behavioral harness and gets no sentence about one.
test('the behavioral harness notice says nothing about a runner with no harness', () => {
  assert.equal(behavioralHarnessNotice('rspec'), null);
  assert.equal(behavioralHarnessNotice('vitest'), null);
});
