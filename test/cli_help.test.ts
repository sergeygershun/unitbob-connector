import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function help(): string {
  // `--help` exits 0; run the CLI the same way a bare client would.
  return execFileSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
}

test('--help carries a pipeline note explaining prepare → host-build → put', () => {
  const text = help();

  assert.match(text, /Pipeline:/);
  assert.match(text, /built on your machine/);
  assert.match(text, /\*-prepare` writes a request/);
  assert.match(text, /output_path/);
  assert.match(text, /put-\*` uploads only the structured result/);
});
