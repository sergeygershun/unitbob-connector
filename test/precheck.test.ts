import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anyStackPrecheck, validateStack, type PrecheckDeps } from '../src/runner/precheck.ts';

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

test('anyStackPrecheck passes when at least one stack matches and fails when none do', () => {
  const python = tmpProject();
  writeFileSync(join(python, 'pyproject.toml'), '');
  assert.equal(anyStackPrecheck(python, pytestPresent).ok, true);

  const empty = anyStackPrecheck(tmpProject(), pytestPresent);
  assert.equal(empty.ok, false);
  assert.match(empty.message ?? '', /matches none of those stacks/);
});
