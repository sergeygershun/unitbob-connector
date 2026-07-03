import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalRepoId, writeConfigFile } from '../src/config.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-config-'));
}

test('reads the repo id from a valid .unitbob.json', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, '.unitbob.json'), JSON.stringify({ server: 'https://host', repo_id: 3 }));
  assert.equal(readLocalRepoId(dir), 3);
});

test('a missing file is no working link', () => {
  assert.equal(readLocalRepoId(tmpProject()), null);
});

test('the legacy repo_id: 0 template is no working link', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, '.unitbob.json'), JSON.stringify({ server: 'https://host', repo_id: 0 }));
  assert.equal(readLocalRepoId(dir), null);
});

test('a non-integer repo_id is no working link', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, '.unitbob.json'), JSON.stringify({ server: 'https://host', repo_id: 'three' }));
  assert.equal(readLocalRepoId(dir), null);
});

test('malformed JSON is no working link', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, '.unitbob.json'), '{ not json');
  assert.equal(readLocalRepoId(dir), null);
});

test('never adopts a parent directory config (no walk-up)', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, '.unitbob.json'), JSON.stringify({ server: 'https://host', repo_id: 7 }));
  const nested = join(dir, 'a', 'b');
  mkdirSync(nested, { recursive: true });
  assert.equal(readLocalRepoId(nested), null);
});

test('writeConfigFile round-trips through readLocalRepoId', () => {
  const dir = tmpProject();
  writeConfigFile(dir, { server: 'http://localhost:3000', repo_id: 42 });
  assert.equal(readLocalRepoId(dir), 42);
  const raw = JSON.parse(readFileSync(join(dir, '.unitbob.json'), 'utf8'));
  assert.deepEqual(raw, { server: 'http://localhost:3000', repo_id: 42 });
});
