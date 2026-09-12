import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { putKnowledge } from '../src/verbs/putKnowledge.ts';
import { knowledgePath } from '../src/files/features.ts';
import type { Config } from '../src/config.ts';
import { WireError } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-put-knowledge-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, token: 'secret', projectRoot };
}

function writeKnowledge(projectRoot: string, text: string): void {
  const path = knowledgePath(projectRoot, 12);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test('put-knowledge sends the file text and prints the sentence and the link', async () => {
  const projectRoot = tmpProject();
  writeKnowledge(projectRoot, '# Refunds\n\n## Intent\n');
  const out: string[] = [];
  let sent: { id: number | string; knowledge: string } | null = null;

  await putKnowledge(config(projectRoot), ['12'], {
    putKnowledge: async (id, knowledge) => {
      sent = { id, knowledge };
      return { url: '/repos/3/features/12', message: 'Feature talked through: "Refunds". 2 scenarios; every promise stays.' };
    },
    stdout: { write: (chunk) => out.push(String(chunk)) },
  });

  assert.deepEqual(sent, { id: 12, knowledge: '# Refunds\n\n## Intent\n' });
  const lines = out.join('').trim().split('\n');
  assert.equal(lines[0], 'Feature talked through: "Refunds". 2 scenarios; every promise stays.');
  assert.equal(lines[1], 'https://host/repos/3/enter?next=%2Frepos%2F3%2Ffeatures%2F12#t=secret');
});

// The refusal is the server's, whole: the wire already put one line per
// problem in it, and this verb lets it through to the terminal and exits
// non-zero through the CLI's one catch.
test('put-knowledge lets the 422 with the problems through, unchanged', async () => {
  const projectRoot = tmpProject();
  writeKnowledge(projectRoot, '# x');
  const refusal = new WireError(
    'PUT knowledge failed: 422 — knowledge.md does not have the expected shape.\nexpected: at least one scenario\n     got: none',
  );

  await assert.rejects(
    () =>
      putKnowledge(config(projectRoot), ['12'], {
        putKnowledge: async () => {
          throw refusal;
        },
        stdout: { write: () => true },
      }),
    (err: unknown) => err === refusal,
  );
});

test('put-knowledge needs the feature id', async () => {
  await assert.rejects(() => putKnowledge(config(tmpProject()), []), /Usage: unitbob put-knowledge <feature_id>/);
});

test('put-knowledge names the missing file', async () => {
  const projectRoot = tmpProject();

  await assert.rejects(() => putKnowledge(config(projectRoot), ['12']), /No knowledge file at/);
});
