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

// The workflow is hard-wrapped, so any phrase longer than a few words is split
// across lines. Match sentences against this flattened copy; a rule must not be
// able to slip past a guard just because the paragraph was re-wrapped.
const flat = suiteWorkflow.replace(/\s+/g, ' ');

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

// Spec 32-6 Phase 0. Two texts were in front of the model at the same time on
// a2time and they disagreed: the server's own recipe said "the app won't boot —
// stop", the workflow said "let the lamp be red; don't stop". Both halves are
// now stated together here, and the boundary between them is something the
// model can observe — did the runner start — instead of a judgement about
// whether the code is healthy.
test('the suite workflow stops when the runner never started', () => {
  assert.match(flat, /runner never started/i);
  // The observable criterion, not "is the app broken".
  assert.match(flat, /died before the first test or scenario/i);
  // Nothing gets written on top of a runner that never ran.
  assert.match(flat, /upload nothing/i);
});

// The other half, and the reason the first half may never be written as a bare
// "stop when something is broken": a broken file in an app that still runs is
// the whole point of the product. Deleting this rule would take that case away.
test('the suite workflow keeps "red lamp, keep generating" for a runner that ran', () => {
  assert.match(flat, /let the lamp be red/i);
  assert.match(flat, /Don't stop to repair the app before generating/i);
  assert.match(flat, /never weaken a check to get green/i);
});

// This sentence used to say the opposite: that `suite-prepare` smoke-runs the
// app and the host should trust it. A run against an app whose core model could
// not load spent hours writing a suite that had no way to be anything but red.
// The workflow may not promise a check that does not exist — and this test is
// the reason it cannot quietly grow back.
//
// 32-6 note: `suite-prepare` now does load the file the suite starts from
// (`runner/bootcheck.ts`), so the old blanket "it never runs your app" is no
// longer the true sentence and is not asserted here. What stays forbidden is
// the promise that made the damage — that the app was already smoke-run and
// the result can be trusted.
test('the suite workflow does not claim a preflight proves the app works', () => {
  assert.doesNotMatch(suiteWorkflow, /smoke-\s*runs/i);
  assert.doesNotMatch(suiteWorkflow, /preflight[^.]*(?:trust|already)/i);
});

// Step 1 says one general thing instead of listing causes, so that a new reason
// to stop (32-6 added one) needs no edit here.
test('the suite workflow stops generally when suite-prepare wrote no request', () => {
  assert.match(flat, /If it does not write that file, relay its message to the user as it stands and stop/i);
  // The old enumeration of particular causes is gone.
  assert.doesNotMatch(flat, /If it reports an unsupported project/i);
  assert.doesNotMatch(flat, /If it reports there is no current map/i);
});
