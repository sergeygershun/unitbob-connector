// Release guard, half one: everything that names a version names the same one.
//
// The plugin does not travel inside the npm package — `package.json` publishes
// `dist` and nothing else — so the `npx -y unitbob@<v>` lines in the workflows
// are read straight from this repository by whoever installed the plugin from
// the marketplace. That makes them executable content, not documentation, and
// there are thirteen places carrying the number.
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

function readJson(...parts: string[]): { version?: string } {
  return JSON.parse(readFileSync(join(root, ...parts), 'utf8'));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

// Every `unitbob@<version>` the plugin tells a host to execute, with the file it
// came from, so a failure names the line to fix rather than a count.
function pins(): { file: string; version: string }[] {
  return filesUnder(join(root, 'plugin')).flatMap((file) => {
    const matches = readFileSync(file, 'utf8').matchAll(/unitbob@(\d+\.\d+\.\d+)/g);
    return [...matches].map((match) => ({ file: file.slice(root.length), version: match[1] }));
  });
}

test('every plugin pin names the version this package publishes', () => {
  const version = readJson('package.json').version;
  assert.ok(version, 'package.json carries no version');

  const wrong = pins().filter((pin) => pin.version !== version);
  assert.deepEqual(
    wrong,
    [],
    `these plugin commands call a version this package is not: expected unitbob@${version}`,
  );
});

// The plugin manifest is the version a host sees listed; disagreeing with the
// CLI it installs makes the pair impossible to reason about from the outside.
test('the plugin manifest agrees with the package', () => {
  assert.equal(readJson('plugin', '.claude-plugin', 'plugin.json').version, readJson('package.json').version);
});

// A pin that stopped matching the `unitbob@<v>` shape would silently leave the
// check above with nothing to compare, and the guard would pass by finding
// nothing rather than by agreeing. Count them instead of trusting the regex.
test('the pins are still where the guard can see them', () => {
  assert.ok(pins().length >= 10, `expected the workflow pins to be found, saw ${pins().length}`);
});
