import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateLinkedRoot, readLocalRepoId, writeConfigFile } from '../src/config.ts';

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
  writeConfigFile(dir, { server: 'https://unitbob-73a4082838d3.herokuapp.com', repo_id: 42 });
  assert.equal(readLocalRepoId(dir), 42);
  const raw = JSON.parse(readFileSync(join(dir, '.unitbob.json'), 'utf8'));
  assert.deepEqual(raw, { server: 'https://unitbob-73a4082838d3.herokuapp.com', repo_id: 42 });
});

// Every verb used to demand the exact project root as the working directory,
// even though the request packet it writes names that root in its own
// `project_root`. An agent driving the CLI from a scratch directory got
// "does not look like a project root" and had to guess its way back.
test('locateLinkedRoot finds the linked root from a subdirectory', () => {
  const root = tmpProject();
  writeConfigFile(root, { server: 'https://host', repo_id: 7 });
  const nested = join(root, 'app', 'models');
  mkdirSync(nested, { recursive: true });

  assert.equal(locateLinkedRoot(nested), root);
  assert.equal(locateLinkedRoot(root), root);
});

// The no-walk-up rule stands: only a directory's own file names its link. This
// relocates to the directory whose file it is, and never lends a parent's id to
// a child that has none.
test('locateLinkedRoot returns null when nothing above is linked', () => {
  const root = tmpProject();
  const nested = join(root, 'packages', 'web');
  mkdirSync(nested, { recursive: true });

  assert.equal(locateLinkedRoot(nested), null);
});

// A stray .unitbob.json in $HOME must not adopt every project underneath it.
test('locateLinkedRoot stops at the home directory', () => {
  const nested = mkdtempSync(join(tmpdir(), 'unitbob-config-nested-'));
  assert.equal(locateLinkedRoot(nested), null);
  assert.equal(locateLinkedRoot(homedir()) === homedir(), readLocalRepoId(homedir()) !== null);
});
