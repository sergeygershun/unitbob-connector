// Release guard, half one: everything that names a version names the same one.
//
// The plugin does not travel inside the npm package — `package.json` publishes
// `dist` and nothing else — so the `npx -y unitbob@<v>` lines in the workflows
// are read straight from this repository by whoever installed the plugin from
// the marketplace. That makes them executable content, not documentation, and
// there are fourteen places carrying the number: twelve such commands, the
// plugin manifest, and `package.json` itself.
//
// They drifted once already: `cb14dd3` bumped `package.json` to 0.2.1 and left
// `SKILL.md` calling `unitbob@0.2.0`, so the plugin kept running the previous
// release while the new one sat published and unused.
//
// This half is offline and therefore lives in the suite. The half that needs the
// network — "does this version exist in npm at all" — is `scripts/check-release.mjs`,
// and it is the one that catches the worse failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// The permission entry in SKILL.md is `unitbob@*` on purpose: it grants the
// host every version rather than naming one. It is the single reference here
// that must *not* track the release.
const WILDCARD = '*';

function readJson(...parts: string[]): { version?: string } {
  return JSON.parse(readFileSync(join(root, ...parts), 'utf8'));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

// Every `unitbob@…` the plugin carries, with the file it came from, so a failure
// names the line to fix rather than a count. Deliberately not anchored to a
// version shape: a reference that stopped looking like a version is exactly what
// this must still see, rather than pass by finding nothing.
function references(): { file: string; version: string }[] {
  return filesUnder(join(root, 'plugin')).flatMap((file) => {
    const matches = readFileSync(file, 'utf8').matchAll(/unitbob@([^\s"'`)]+)/g);
    return [...matches].map((match) => ({ file: file.slice(root.length), version: match[1] }));
  });
}

test('every plugin reference names the version this package publishes', () => {
  const version = readJson('package.json').version;
  assert.ok(version, 'package.json carries no version');

  const wrong = references().filter((ref) => ref.version !== version && ref.version !== WILDCARD);
  assert.deepEqual(
    wrong,
    [],
    `these plugin references call a version this package is not: expected unitbob@${version}`,
  );
});

// The plugin manifest is the version a host sees listed; disagreeing with the
// CLI it installs makes the pair impossible to reason about from the outside.
test('the plugin manifest agrees with the package', () => {
  assert.equal(readJson('plugin', '.claude-plugin', 'plugin.json').version, readJson('package.json').version);
});

// A command that lost its pin would run whatever npm calls latest, which is the
// drift this guards against arriving by omission instead of by mistake. Asked
// per file rather than as a total, so removing a workflow does not trip it and
// no number has to be maintained here.
test('no workflow invokes the connector without naming a version', () => {
  const unpinned = filesUnder(join(root, 'plugin')).filter((file) => {
    const text = readFileSync(file, 'utf8');
    return text.includes('npx -y') && !text.includes('unitbob@');
  });

  assert.deepEqual(unpinned.map((file) => file.slice(root.length)), []);
});
