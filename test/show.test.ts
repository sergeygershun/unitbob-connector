import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoUrl, show } from '../src/verbs/show.ts';

test('repoUrl points at the human repo page where the lamps render, not the map JSON', () => {
  assert.equal(repoUrl({ server: 'https://host', repoId: 3, projectRoot: '/project' }), 'https://host/repos/3');
});

test('show prints the repo page as its only output line', async () => {
  let output = '';
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    await show({ server: 'https://host', repoId: 3, projectRoot: '/project' });
  } finally {
    process.stdout.write = original;
  }

  assert.equal(output, 'https://host/repos/3\n');
});
