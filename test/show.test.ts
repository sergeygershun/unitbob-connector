import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoUrl, show } from '../src/verbs/show.ts';
import { enterUrl } from '../src/links.ts';

const config = { server: 'https://host', repoId: 3, token: 'secret-token', projectRoot: '/project' };

// Spec 33. The console answers 404 to a browser that has not proved it holds
// this project's key, so a printed link goes through the exchanger and carries
// the token in the fragment — the one part of a URL that never reaches the
// server, and therefore never its logs.
test('repoUrl points at the exchanger, carrying the token in the fragment', () => {
  assert.equal(repoUrl(config), 'https://host/repos/3/enter?next=%2Frepos%2F3#t=secret-token');
});

test('show prints that link as its only output line', async () => {
  let output = '';
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    await show(config);
  } finally {
    process.stdout.write = original;
  }

  assert.equal(output, 'https://host/repos/3/enter?next=%2Frepos%2F3#t=secret-token\n');
});

// The link the connector prints most often is not the console but the map, after
// every build and every run. A `?tab=`-only exchanger would have dropped
// everyone on the overview instead.
test('enterUrl carries an absolute server address through as the destination', () => {
  assert.equal(
    enterUrl(config, 'https://host/repos/3/map/product'),
    'https://host/repos/3/enter?next=%2Frepos%2F3%2Fmap%2Fproduct#t=secret-token',
  );
});

test('enterUrl keeps a query on the destination', () => {
  assert.equal(
    enterUrl(config, '/repos/3?tab=behavioral'),
    'https://host/repos/3/enter?next=%2Frepos%2F3%3Ftab%3Dbehavioral#t=secret-token',
  );
});

test('enterUrl falls back to the console when the destination is unusable', () => {
  assert.equal(
    enterUrl(config, 'not a url'),
    'https://host/repos/3/enter?next=%2Frepos%2F3#t=secret-token',
  );
});

// A URL has exactly one fragment, and the token now occupies it. The old `#map`
// anchor could not have survived beside it — which is why the map moved to an
// address of its own.
test('no printed link carries a second fragment', () => {
  for (const link of [repoUrl(config), enterUrl(config, 'https://host/repos/3/map/product')]) {
    assert.equal(link.split('#').length, 2);
    assert.ok(!link.includes('#map'));
  }
});
