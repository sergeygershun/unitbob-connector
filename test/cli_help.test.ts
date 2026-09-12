import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const binPath = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

function help(): string {
  // `--help` exits 0; run the CLI the same way a bare client would.
  return execFileSync(process.execPath, [binPath, '--help'], { encoding: 'utf8' });
}

test('--help carries a pipeline note explaining prepare → host-build → put', () => {
  const text = help();

  assert.match(text, /Pipeline:/);
  assert.match(text, /built on your machine/);
  assert.match(text, /\*-prepare` writes a request/);
  assert.match(text, /output_path/);
  assert.match(text, /put-\*` uploads only the structured result/);
});

test('--help exposes the one-time Codex agent installer', () => {
  assert.match(help(), /codex-install\s+Install the bounded Unitbob worker definitions for Codex/);
});

// Spec 52-2: the pair that talks a recorded feature through.
test('--help exposes knowledge-prepare and put-knowledge (spec 52-2)', () => {
  const text = help();

  assert.match(text, /knowledge-prepare\s+Internal: without an id, list the features that can be talked through/);
  assert.match(text, /put-knowledge\s+Internal: send the feature's knowledge\.md/);
});

// Spec 52-3: the pair that writes a feature's checks, and the feature flag
// of run-local that runs them alone.
test('--help exposes tests-prepare, put-tests and run-local --feature (spec 52-3)', () => {
  const text = help();

  assert.match(text, /tests-prepare <id>\s+Internal: fetch the feature's assignment and the recipe/);
  assert.match(text, /put-tests <id>\s+Internal: run the feature's checks, send them with that run as the proof/);
  assert.match(text, /run-local \[branch\] \| --feature <id>/);
});

// Spec 52-1: the pair that records an intent before the change is made.
test('--help exposes feature-prepare and put-feature', () => {
  const text = help();

  assert.match(text, /feature-prepare\s+Internal: fetch the recipe and the product capabilities/);
  assert.match(text, /put-feature\s+Internal: record the host's feature answer/);
});
