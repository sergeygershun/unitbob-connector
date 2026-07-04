import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimePrecheck } from '../src/runner/precheck.ts';

function tmpProject(gemfile?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-precheck-'));
  if (gemfile !== undefined) writeFileSync(join(dir, 'Gemfile'), gemfile);
  return dir;
}

test('passes on Rails + rspec-rails without any spec/rails_helper.rb (spec 29)', () => {
  const dir = tmpProject("gem 'rails'\ngem 'rspec-rails'\n");
  assert.deepEqual(runtimePrecheck(dir), { ok: true });
});

test('fails without the rails gem', () => {
  const check = runtimePrecheck(tmpProject("gem 'sinatra'\n"));
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /no `rails` gem found in Gemfile/);
});

test('missing rspec-rails instructs the agent to offer the gem, with consent', () => {
  const check = runtimePrecheck(tmpProject("gem 'rails'\n"));
  assert.equal(check.ok, false);
  assert.match(check.message ?? '', /need the rspec-rails gem/);
  assert.match(check.message ?? '', /Offer the user to add it and run `bundle install`/);
  assert.match(check.message ?? '', /only with their consent, then retry/);
});
