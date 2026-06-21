import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureUnitbobIgnored, runGraphifyExtractKeyless, runProcess } from '../src/proc.ts';

function tmpProject(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('runGraphifyExtractKeyless runs `graphify update <root> --force` with no key and no --out', async () => {
  const projectRoot = tmpProject('unitbob-proc-project-');
  const binDir = tmpProject('unitbob-proc-bin-');
  const logPath = join(projectRoot, 'args.log');
  const graphifyPath = join(binDir, 'graphify');
  writeFileSync(
    graphifyPath,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${logPath}"\nexit 0\n`,
  );
  chmodSync(graphifyPath, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath ?? ''}`;
  try {
    const result = await runGraphifyExtractKeyless(projectRoot);
    assert.equal(result.code, 0);
  } finally {
    process.env.PATH = oldPath;
  }

  assert.deepEqual(readFileSync(logPath, 'utf8').trim().split('\n'), [
    'update',
    projectRoot,
    '--force',
  ]);
});

test('ensureUnitbobIgnored appends .unitbob and graphify-out once each', () => {
  const projectRoot = tmpProject('unitbob-proc-ignore-');
  const ignorePath = join(projectRoot, '.graphifyignore');
  const gitignorePath = join(projectRoot, '.gitignore');
  writeFileSync(ignorePath, 'tmp/\n');
  writeFileSync(gitignorePath, '.env\n');

  ensureUnitbobIgnored(projectRoot);
  ensureUnitbobIgnored(projectRoot);

  assert.equal(readFileSync(ignorePath, 'utf8'), 'tmp/\n.unitbob/\n');
  assert.equal(readFileSync(gitignorePath, 'utf8'), '.env\n.unitbob/\ngraphify-out/\n');
});

test('ensureUnitbobIgnored adds graphify-out exactly once and preserves an existing entry', () => {
  const projectRoot = tmpProject('unitbob-proc-ignore-existing-');
  const gitignorePath = join(projectRoot, '.gitignore');
  writeFileSync(gitignorePath, 'node_modules/\ngraphify-out/\n');

  ensureUnitbobIgnored(projectRoot);

  assert.equal(readFileSync(gitignorePath, 'utf8'), 'node_modules/\ngraphify-out/\n.unitbob/\n');
});

test('runProcess reports a timeout as a local process failure', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 1000)'],
    { timeoutMs: 20 },
  );

  assert.equal(result.code, null);
  assert.match(result.stderr, /timed out after 20ms/);
});
