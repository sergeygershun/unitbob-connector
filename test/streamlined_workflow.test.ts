import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Spec 32-3: building maps + suites on a2time cost far too much back-and-forth —
// an approval per command, walls of reasoning, and questions scattered one at a
// time. 32-3 is guidance, not a mechanism: the connector's skill carries the
// rules that make the conversation shorter, and ships a ready permissions block.
const skill = readFileSync(
  fileURLToPath(new URL('../plugin/skills/unitbob/SKILL.md', import.meta.url)),
  'utf8',
);
const suiteWorkflow = readFileSync(
  fileURLToPath(new URL('../plugin/skills/unitbob/workflows/suite.md', import.meta.url)),
  'utf8',
);

test('the skill tells the LLM to keep messages short and structured', () => {
  assert.match(skill, /How to talk to the user during the workflow/i);
  // No dumping generated files, no reasoning walls, no raw tool output.
  assert.match(skill, /don't dump generated files/i);
  assert.match(skill, /don't narrate your reasoning/i);
  assert.match(skill, /don't echo raw tool output/i);
  // Findings as compact bullets; checkpoints stay to a line or two.
  assert.match(skill, /one compact bullet/i);
  assert.match(skill, /one or two lines/i);
});

test('the skill gives the ask-vs-decide criterion and one final checkpoint', () => {
  assert.match(skill, /When to ask the user, and when to just decide/i);
  // Ask only on (a) production-code change or (b) what-gets-built-next.
  assert.match(skill, /changes their production code/i);
  assert.match(skill, /changes what gets built or run next/i);
  // Everything else is decided and reported in one line, not discussed.
  assert.match(skill, /decide yourself and report in one line/i);
  // Real questions are gathered into a single closing checkpoint.
  assert.match(skill, /one\s+checkpoint at the end/i);
});

test('the skill ships a ready read-only permissions block and points at the skill', () => {
  assert.match(skill, /Fewer approvals/i);
  assert.match(skill, /\.claude\/settings\.json/);
  assert.match(skill, /"permissions"/);
  assert.match(skill, /"Bash\(grep:\*\)"/);
  // Points at the built-in automation as the preferred path.
  assert.match(skill, /fewer-permission-prompts/);

  // The allowlist must be read-only: no state-changing command may appear in the
  // permissions block. This was the whole safety line the design drew.
  const block = skill.slice(skill.indexOf('"permissions"'));
  const allow = block.slice(0, block.indexOf(']'));
  for (const forbidden of [
    'bundle install',
    'npm i',
    'pip install',
    'db:migrate',
    'git push',
    'deploy',
    'rm ',
  ]) {
    assert.doesNotMatch(
      allow,
      new RegExp(`"[^"]*${forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `permissions.allow must not include the state-changing command "${forbidden}"`,
    );
  }
});

test('the suite workflow keeps the boot hint as a one-liner, not a pre-flight scan', () => {
  // A non-booting app is a defect that becomes a red lamp — not something to
  // repair before generating.
  assert.match(suiteWorkflow, /boots/i);
  assert.match(suiteWorkflow, /red lamp/i);
});

// This sentence used to say the opposite: that `suite-prepare` smoke-runs the
// app and the host should trust it. `runner/precheck.ts` says in its own words
// that it boots nothing, and a run against an app whose core model could not
// load spent hours writing a suite that had no way to be anything but red.
// The workflow may not promise a check that does not exist — and this test is
// the reason it cannot quietly grow back.
test('the suite workflow does not claim a preflight runs the app', () => {
  assert.doesNotMatch(suiteWorkflow, /smoke-\s*runs/i);
  assert.doesNotMatch(suiteWorkflow, /preflight[^.]*(?:trust|already)/i);
  assert.match(suiteWorkflow, /never runs your app/i);
});
