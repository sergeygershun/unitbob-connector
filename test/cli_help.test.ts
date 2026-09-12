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

// Spec 52-1: the pair that records an intent before the change is made.
test('--help exposes feature-prepare and put-feature', () => {
  const text = help();

  assert.match(text, /feature-prepare\s+Internal: fetch the recipe and the product capabilities/);
  assert.match(text, /put-feature\s+Internal: record the host's feature answer/);
});
