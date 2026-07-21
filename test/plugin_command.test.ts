import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The protocols live in the skill, not in the commands. A vibecoder in a browser
// window has the skill but no `/unitbob:...` commands — they register only in a
// Claude Code terminal, in a session started after the plugin was installed. When
// the protocol lived in the command file, that user hit a dead end: the skill said
// "run /unitbob:map" and there was nothing to run. (Observed on a2time,
// 2026-07-21: the agent worked around it by finding map.md on disk and reading it
// by hand.) Commands are now thin pointers at the same files, so both routes run
// the identical protocol.
const workflow = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../plugin/skills/unitbob/workflows/${name}.md`, import.meta.url)), 'utf8');
const command = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../plugin/commands/${name}.md`, import.meta.url)), 'utf8');
const skill = readFileSync(
  fileURLToPath(new URL('../plugin/skills/unitbob/SKILL.md', import.meta.url)),
  'utf8',
);

const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const connectorVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version as string;
// Spec 29: warnings suppressed, npm's own errors stay visible (never --silent).
const unitbob = `npx -y --loglevel=error unitbob@${connectorVersion}`;
const unitbobPattern = unitbob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const WORKFLOWS = ['map', 'suite', 'check', 'show', 'fix'];

test('the skill can run every workflow without a slash command', () => {
  for (const name of WORKFLOWS) {
    assert.match(skill, new RegExp(`workflows/${name}\\.md`), `SKILL.md must point at workflows/${name}.md`);
  }

  // Naming a command as the way to do the work is the dead end itself.
  assert.doesNotMatch(skill, /→ run `\/unitbob:/);
  // Line-wrapped in the prompt, so match across the break.
  assert.match(skill, /never\s+hand\s+the\s+user\s+a\s+slash\s+command/i);
});

// Moving the protocols was not enough on its own: four slash commands were left
// inside them, pointing the user or the next step at something that does not
// exist outside a terminal ("Then tell the user to run /unitbob:check"). A
// workflow reaches a sibling workflow by name, and reaches the user in words.
test('no workflow sends anyone to a slash command', () => {
  for (const name of WORKFLOWS) {
    assert.doesNotMatch(
      workflow(name),
      /\/unitbob[: ](map|suite|check|show|fix)\b/,
      `${name}.md must point at a sibling workflow or ask in plain words`,
    );
  }
});

test('each command is a thin pointer at the workflow it shares with the skill', () => {
  for (const name of WORKFLOWS) {
    const text = command(name);

    assert.match(text, new RegExp(`\\$\\{CLAUDE_PLUGIN_ROOT\\}/skills/unitbob/workflows/${name}\\.md`));
    // Thin means thin: no second copy of the protocol to drift from the first.
    assert.doesNotMatch(text, new RegExp(unitbobPattern));
    assert.ok(text.split('\n').length < 15, `${name}.md should stay a pointer, not a protocol`);
  }
});

test('map workflow stitches connector hands and is self-contained', () => {
  const text = workflow('map');

  assert.match(text, new RegExp(`${unitbobPattern} map-prepare`));
  assert.match(text, new RegExp(`${unitbobPattern} put-map-build`));
  assert.match(text, /Read `\.unitbob\/map-build\/request\.json`/);
  assert.match(text, /Write strict JSON only/);
  assert.doesNotMatch(text, /ai\/agents\/map_builder\.md/);
  assert.doesNotMatch(text, /npx unitbob(?!@).* map(?!-)/);
});

test('suite workflow stitches suite-prepare, the host agent, and put-suite-build', () => {
  const text = workflow('suite');

  assert.match(text, new RegExp(`${unitbobPattern} suite-prepare`));
  assert.match(text, new RegExp(`${unitbobPattern} put-suite-build`));
  assert.match(text, /Read `\.unitbob\/suite-build\/request\.json`/);
  assert.doesNotMatch(text, /ai\/agents\/suite_builder\.md/);
  assert.match(text, /Write strict JSON only/);
  // Never asks the connector to interpret the suite — it only stitches hands.
  assert.doesNotMatch(text, /npx unitbob(?!@).* suite(?!-)/);
});

test('fix workflow stitches fix-prepare and covers both fix and accept', () => {
  const text = workflow('fix');

  assert.match(text, new RegExp(`${unitbobPattern} fix-prepare <guard_id>`));
  assert.match(text, /Read `\.unitbob\/fix\/request\.json`/);
  assert.doesNotMatch(text, /ai\/agents\/fixer\.md/);
  // Fix edits code (no upload); accept republishes the whole suite via put-suite-build.
  assert.match(text, new RegExp(`${unitbobPattern} put-suite-build`));
  // `$ARGUMENTS` is a command-only substitution — inside a workflow it stays literal.
  assert.doesNotMatch(text, /\$ARGUMENTS/);
});
