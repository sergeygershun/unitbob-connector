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

const WORKFLOWS = ['map', 'suite', 'check', 'show', 'fix', 'feature', 'knowledge'];

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
      /\/unitbob[: ](map|suite|check|show|fix|feature|knowledge)\b/,
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

// Spec 40, criterion 3. `known_defect_probe` is the only mechanical proof in the
// whole system that a lamp really goes red when the thing it names breaks: the
// server re-runs the new scenario against the revision before the fix. Across six
// bench projects on 2026-09-05 it never ran once — every build carried
// `{"status": "not_supplied"}` — because step 1 offered both options and nothing
// anywhere said where a known defect would come from, so the coordinator reached
// for the default every time. It comes from what the user already said.
//
// Two files, and deliberately not three. The workflow is where the flag is
// chosen, so the rule for choosing it belongs there; the skill carries the policy
// around it, the way it carries every other rule about spending a user's turn.
// `commands/suite.md` stays the thin pointer it is elsewhere — a third copy would
// be the drift this file's other tests exist to prevent.
test('the workflow and the skill carry a bug the user just fixed into the run', () => {
  for (const [where, text] of [
    ['SKILL.md', skill],
    ['workflows/suite.md', workflow('suite')],
  ] as const) {
    assert.match(text, /--known-defect=/, `${where} must name the flag`);
    assert.match(text, /--fixed-revision=/, `${where} must name the revision that can go with it`);
    assert.match(text, /--no-known-defect/, `${where} must name the default it replaces`);
    // The user's own words are the source, and nothing here may read as a licence
    // to open a second question — not about the defect and not about the
    // revision. `suite.md` defends its single question as the only turn in the
    // whole workflow worth spending, and "is there a known defect?" would come
    // back "no" nearly always: a vibecoder installs Unitbob to find the defects
    // nobody could name.
    assert.match(text, /Never a question/, `${where} must rule out asking for it`);
  }

  // `--fixed-revision` is optional at the command line — `knownDefectContext` in
  // `suitePrepare.ts` rejects only the pairing with `--no-known-defect` — and it
  // has to stay optional in the prose too. A user's sentence about this morning's
  // fix names a bug, almost never a revision, so wording that demands one is
  // wording that sends the coordinator back to ask.
  for (const [where, text] of [
    ['SKILL.md', skill],
    ['workflows/suite.md', workflow('suite')],
  ] as const) {
    assert.match(text, /--fixed-revision=[\s\S]{0,200}\bonly\b/, `${where} must keep the revision optional`);
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
  assert.match(text, new RegExp(`${unitbobPattern} suite-review-prepare`));
  assert.match(text, new RegExp(`${unitbobPattern} put-suite-build`));
  assert.match(text, /Read `\.unitbob\/suite-build\/request\.json`/);
  assert.doesNotMatch(text, /ai\/agents\/suite_builder\.md/);
  assert.match(text, /Write strict JSON only/);
  assert.match(text, /application failures remain red/i);
  assert.match(text, /BDD quality review/i);
  assert.match(text, /independent reviewer/i);
  assert.match(text, /bdd_quality_review/);
  assert.match(text, /known_defect_probe/);
  assert.match(text, /--known-defect=/);
  assert.match(text, /--no-known-defect/);
  assert.match(text, /behavioral_review\.json/);
  assert.match(text, /must not.*bdd_quality_review.*test_metadata/is);
  assert.doesNotMatch(text, /behavioral[\s\S]{0,500}iterate to green/i);
  // Never asks the connector to interpret the suite — it only stitches hands.
  assert.doesNotMatch(text, /npx unitbob(?!@).* suite(?!-)/);
});

// Spec 32-4. The a2time session on 2026-07-29 published a structural suite, found
// a live defect in its own local run, and told the user the defect "shows as a red
// lamp on the map". Nothing had ever run the published suite, so the map was gray.
// Two things had to change: one command now publishes *and* runs, and the workflow
// may only source colors from that run's server summaries.
//
// Spec 41, criterion 3 made it one publish *per branch* rather than one per run:
// a2time, 2026-09-05 was interrupted mid-repair and left nothing on the server,
// with the structural branch minutes from done. Each call still publishes and
// runs what it published, which is the part 32-4 bought and this must not spend.
test('the suite workflow publishes and runs each branch as it finishes, with no second user turn', () => {
  const text = workflow('suite');
  const publishes = text.match(new RegExp(`${unitbobPattern} put-suite-build \\w+`, 'g')) ?? [];

  assert.deepEqual(
    publishes.map((line) => line.split(' ').pop()),
    ['structural', 'behavioral'],
    'one publish per branch, named, structural first',
  );
  assert.match(text, /publishes that branch, runs it/i);
  // Asking for the first run as a second turn is the failure this spec removed.
  assert.match(text, /never\s+ask\s+the\s+user\s+to\s+run\s+the\s+checks\s+to\s+finish\s+generating/i);
});

test('the suite workflow never claims a local run already painted the map', () => {
  const text = workflow('suite');

  assert.doesNotMatch(text, /show as red lamps on the map/);
  assert.match(text, /only\s+from\s+the\s+server's\s+run\s+summaries/i);
  assert.match(text, /Never\s+turn\s+a\s+local\s+build\s+run[\s\S]{0,120}into\s+a\s+claim/i);
});

// Recovery after an interrupted first run, and every later re-run, still belong to
// the standalone flow — it must keep running everything, not just what some
// earlier publish returned.
test('the check workflow stays the unfiltered standalone run', () => {
  const text = workflow('check');

  assert.match(text, new RegExp(`${unitbobPattern} run`));
  assert.match(text, /both current/);
  assert.doesNotMatch(text, new RegExp(`${unitbobPattern} put-suite-build`));
});

test('fix workflow drives contract-prompt and covers both fix and accept on either map', () => {
  const text = workflow('fix');

  // Spec 32: one selector — suite_digest + test_id + intent — for both maps.
  assert.match(text, new RegExp(`${unitbobPattern} contract-prompt <suite_digest> <test_id>`));
  assert.match(text, /\.unitbob\/structural\//);
  assert.match(text, /\.unitbob\/behavioral\//);
  assert.doesNotMatch(text, /ai\/agents\/fixer\.md/);
  // Fix edits code (no upload); accept republishes that suite via put-suite-build.
  assert.match(text, new RegExp(`${unitbobPattern} put-suite-build`));
  assert.match(text, new RegExp(`${unitbobPattern} suite-review-prepare`));
  assert.doesNotMatch(text, /whole suite of that kind to green/i);
  assert.match(text, /application failures remain red/i);
  // `$ARGUMENTS` is a command-only substitution — inside a workflow it stays literal.
  assert.doesNotMatch(text, /\$ARGUMENTS/);
});

// Spec 52-1. The feature workflow is the one step that must not turn into a
// conversation or into code: it records what was said and names what it may
// touch, and everything else is another workflow's.
test('the feature workflow records the intent without asking or implementing', () => {
  const text = workflow('feature');

  assert.match(text, new RegExp(`${unitbobPattern} feature-prepare`));
  assert.match(text, new RegExp(`${unitbobPattern} put-feature`));
  assert.match(text, /not.*ask questions/i);
  assert.match(text, /not.*start implementing/i);
  assert.match(text, /unknown_ids/);
  assert.match(skill, /Start a feature safely/);
  // Spec 52-2: it does not end on the link — it offers the talk, once.
  assert.match(text, /talk\s+it\s+through\s+now/i);
  assert.match(text, /workflows\/knowledge\.md/);
});

// Spec 52-2. The knowledge workflow is a conversation with one upload at the
// end, and the upload waits for the user's word.
test('the knowledge workflow finds the feature, asks by the recipe, and uploads only on yes', () => {
  const text = workflow('knowledge');

  assert.match(text, new RegExp(`${unitbobPattern} knowledge-prepare\\b`));
  assert.match(text, new RegExp(`${unitbobPattern} knowledge-prepare <id>`));
  assert.match(text, new RegExp(`${unitbobPattern} put-knowledge <id>`));
  assert.match(text, /five questions a round and three\s+rounds/i);
  assert.match(text, /Is this what done means\?/);
  assert.match(text, /Only on an explicit "yes"/);
  assert.match(text, /not.*start implementing/i);
  assert.match(text, /expected:.*got:/);
  assert.match(skill, /Talk a feature through/);
});
