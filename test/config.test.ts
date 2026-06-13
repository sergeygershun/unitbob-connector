import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-config-'));
}

test('loads a valid .unitbob.json', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, '.unitbob.json'), JSON.stringify({ server: 'https://host', repo_id: 3 }));
  assert.deepEqual(loadConfig(dir), { server: 'https://host', repoId: 3, projectRoot: dir });
});

test('trims a trailing slash on server', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, '.unitbob.json'), JSON.stringify({ server: 'https://host/', repo_id: 1 }));
  assert.equal(loadConfig(dir).server, 'https://host');
});

test('finds the config by walking up from a subdirectory', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, '.unitbob.json'), JSON.stringify({ server: 'https://host', repo_id: 7 }));
  const nested = join(dir, 'a', 'b');
  mkdirSync(nested, { recursive: true });
  assert.deepEqual(loadConfig(nested), { server: 'https://host', repoId: 7, projectRoot: dir });
});

test('missing config fails with a setup message, not a stack trace', () => {
  const dir = tmpProject();
  assert.throws(() => loadConfig(dir), /No \.unitbob\.json found.*unitbob init/s);
});

test('malformed JSON fails with an actionable message', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, '.unitbob.json'), '{ not json');
  assert.throws(() => loadConfig(dir), /not valid JSON/);
});

test('missing server fails with an actionable message', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, '.unitbob.json'), JSON.stringify({ repo_id: 3 }));
  assert.throws(() => loadConfig(dir), /missing a "server" string/);
});

test('non-integer repo_id fails with an actionable message', () => {
  const dir = tmpProject();
  writeFileSync(join(dir, '.unitbob.json'), JSON.stringify({ server: 'https://host', repo_id: 'three' }));
  assert.throws(() => loadConfig(dir), /missing an integer "repo_id"/);
});
