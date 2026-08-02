// `--project-root` (spec 32-5): the folder a verb runs against, for callers that
// cannot change directory — an agent driving the CLI from a scratch directory, a
// hook, a monorepo script. Parsed once for every verb, because a flag that means
// one thing for `check` and another for `suite-prepare` is worse than no flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import type { Config } from '../src/config.ts';

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

// `show` is the cheapest verb that needs a link and touches no network of its
// own, so it exercises the flag without standing up a server.
async function rootSeenBy(argv: string[]): Promise<string | undefined> {
  let seen: string | undefined;
  await main(argv, {
    ensureLinked: async (cwd) => {
      seen = cwd;
      return config(cwd ?? process.cwd());
    },
  });
  return seen;
}

test('--project-root=<dir> is passed to linking and removed from the verb arguments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-flag-'));
  assert.equal(await rootSeenBy([`--project-root=${dir}`, 'show']), dir);
});

test('--project-root <dir> works as two arguments too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-flag-'));
  assert.equal(await rootSeenBy(['--project-root', dir, 'show']), dir);
});

// It may appear after the verb: an agent appending it to a command it already
// composed should not have to rebuild the line.
test('--project-root is recognised after the verb', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-flag-'));
  assert.equal(await rootSeenBy(['show', `--project-root=${dir}`]), dir);
});

test('without the flag, linking is left to resolve the project itself', async () => {
  assert.equal(await rootSeenBy(['show']), undefined);
});

// Failing here names the flag. Passing a bad path through would fail much later,
// as "not a project root", about a directory the user never typed.
test('a --project-root that is not a directory fails before any verb runs', async () => {
  let linked = false;
  const code = await main(['--project-root=/no/such/place', 'show'], {
    ensureLinked: async () => { linked = true; return config('/'); },
  });

  assert.equal(code, 1);
  assert.equal(linked, false);
});

test('--project-root with no value fails instead of swallowing the verb', async () => {
  let linked = false;
  const code = await main(['--project-root'], {
    ensureLinked: async () => { linked = true; return config('/'); },
  });

  assert.equal(code, 1);
  assert.equal(linked, false);
});
