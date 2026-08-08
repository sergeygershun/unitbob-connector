import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUN_BUDGET } from '../src/files/budget.ts';

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

// Spec 34-2, criterion 5. The ceiling has to be somewhere the host reads on its
// first step. It is in `request.json` for that reason, and repeated here because
// the workflow is what turns a number into an instruction.
test('the suite workflow obeys the budget the request states', () => {
  // Derived from the constant, never retyped. The numbers live in `budget.ts`
  // and are quoted here as instructions; a literal in both places is the drift
  // `plugin_pins.test.ts` already exists because of, on a value that is even
  // easier to tune and forget.
  const stated = Object.entries(RUN_BUDGET).map(([field, number]) => `"${field}": ${number}`).join(', ');
  assert.ok(flat.includes(`{ ${stated} }`), `suite.md must state the budget as { ${stated} }`);
  // The same wording `runner_manifest` already gets, and for the same reason.
  assert.match(flat, /do not exceed it and do not invent it/i);
  // Only two of the three have a counter behind them, and the host must not be
  // told which: knowing where the meter is, is a reason to treat the rest as
  // advice.
  assert.match(flat, /Do not sort the fields into ones you think are checked/i);
  // An older connector writes no budget, and that is not an error.
  assert.match(flat, /no `budget` at all/i);
});

// Criterion 6. On autobrella the fan stood on review, where the work is
// mechanical, and was missing from generation, where the work is reading code —
// one agent took 63 capabilities and wrote the last third without reading the
// sources.
test('the suite workflow puts a bounded fan-out where the reading is', () => {
  assert.match(flat, /`unitbob:suite-worker`/i);
  assert.match(flat, /always exactly one reviewer/i);
  assert.match(flat, /fresh `unitbob:suite-repair-worker`/i);
  assert.doesNotMatch(flat, /continuation of its own context/i);
});

// Spec 34-3, criterion 3. `budget.workers: 4` never said what it counted, and
// autobrella read it as four across the build: two workers on structural and two
// on behavioral. Those two reached contexts of 760,000 and 705,000 tokens and
// were 62 % of the whole run between them. An agent re-reads its context every
// turn, so only the variable half of its cost divides when you split it — which
// means splitting never loses, and the smallest sufficient number of workers is
// the most expensive choice available.
test('the suite workflow counts budget.workers per branch and creates only non-empty slices', () => {
  assert.match(flat, /ceiling is \*\*per branch\*\*/i);
  assert.match(flat, /`1\.\.min\(budget\.workers, capability_count\)`/i);
  assert.match(flat, /never create an empty slice/i);
});

// Same criterion, and nothing in the plugin used to say it: `parallel`,
// `concurrently` and `simultaneously` appeared nowhere in it. A fan launched one
// worker at a time costs the same and finishes later.
test("the suite workflow starts a branch's workers in one go", () => {
  assert.match(flat, /Start a branch's workers together, in one go/i);
  assert.match(flat, /Sequential slices save nothing and finish later/i);
  // Twice the workers is not permission to run the shared test database twice.
  assert.match(flat, /never run the suite themselves/i);
});

// The fact-finder's ceilings are frontmatter, so they hold whatever the session
// is. Workers have no definition file — the coordinator launches them — so an
// unnamed model is the session's, and the 72 % of a run they account for would
// silently follow whichever model the operator opened their terminal on. Only
// the cheap 11 % was pinned; this pins the expensive part too.
test('the suite workflow uses named workers whose frontmatter owns model and maxTurns', () => {
  assert.match(flat, /named agent.*`unitbob:suite-worker`/i);
  assert.match(flat, /frontmatter.*60/i);
  assert.match(flat, /never continue/i);
});

// Criterion 1. The workers' own lookups are what turned a budget of four into 36
// live agents. The need is real — a worker may not run anything, so it either
// looks the factory's arguments up or invents them — so the fix is a named agent
// with ceilings (`plugin/agents/fact-finder.md`) rather than a prohibition.
// Naming it is the entire mechanism: the host's default agent has no ceilings at
// all, which is how one lookup ran 109 turns on the costliest model.
test('the suite workflow sends workers to the named fact-finder, capped at eight', () => {
  assert.match(flat, /`unitbob:fact-finder`/);
  assert.match(flat, /no more than \*\*eight\*\* lookups per worker/i);
  assert.match(flat, /no ceiling on model, turn count, or answer length/i);
  assert.match(flat, /Closed questions with the files to look in/i);
});

// Criterion 4. 34-2 said a worker triages its own red scenarios, which quietly
// assumed the cause sits where its author can reach. On autobrella it did not:
// 55 of 81 failures in one round were a missing mixin in the shared step file,
// worker 3 diagnosed it correctly, could not edit a file it did not own, and
// worked around it instead. The round bought nothing.
//
// The workflow says only who repairs what. Whether a failure may be repaired at
// all is the recipe's call — it reads the stack — and the workflow deliberately
// does not restate that verdict: it is a rule about the content of a run, it
// lives in a document fetched from the server, and a second copy across a repo
// boundary is one nothing here can reconcile.
test('the suite workflow groups failures and keeps the shared file for the coordinator', () => {
  assert.match(flat, /group the failures by the verbatim text of the error/i);
  assert.match(flat, /look yourself at any error that turns up under more than one worker/i);
  assert.match(flat, /host-owned shared step.*fixed once/i);
  assert.match(flat, /connector-owned World.*never.*patch/i);
  // The verdict itself is the recipe's, and is not repeated here.
  assert.doesNotMatch(flat, /bucket one/i);
  assert.doesNotMatch(flat, /first frame/i);
});

test('the suite workflow mechanically gates plan before fan-out and checkpoints before repair', () => {
  const planGate = flat.indexOf('validate-worker-plan');
  const fanOut = flat.indexOf("Start a branch's workers together");
  const checkpointGate = flat.indexOf('validate-worker-checkpoints');
  assert.ok(planGate >= 0 && fanOut > planGate);
  assert.ok(checkpointGate > fanOut);
  assert.match(flat, /If validation exits non-zero.*stop before fan-out/i);
});

test('the coordinator workflow is finite', () => {
  assert.match(flat, /one planning pass/i);
  assert.match(flat, /at most one host-owned shared harness correction/i);
  assert.match(flat, /one fresh repair rotation/i);
  assert.match(flat, /exactly one final run/i);
  assert.doesNotMatch(flat, /continue (?:the )?(?:coordinator|worker).*context/i);
});

// Criterion 2, and the reason this whole spec exists. The deadlock was never the
// publication gate — it was that the workflow offered a move after which the
// gate fired legitimately. Take the move away and the gate stops firing.
test('the suite workflow gives the reviewer three written verdicts and no veto', () => {
  assert.match(flat, /does_not_pass/);
  assert.match(flat, /reviewer_objection_text/);
  assert.match(flat, /There is no answer that consists of writing nothing/i);
  // The fields a recorded objection may leave out, so the reviewer does not
  // invent an outcome for a Scenario it just said has none.
  assert.match(flat, /owes only `scenario`, `case_marker`, `verdict`, and that text/i);
});

// This is the sentence that cost 381 sound Scenarios and 202 written reviews on
// autobrella, 2026-08-06. It may not grow back.
test('the suite workflow no longer tells the reviewer to write no artifact', () => {
  assert.doesNotMatch(flat, /write no artifact at all/i);
  assert.doesNotMatch(flat, /that is the veto/i);
  assert.doesNotMatch(flat, /not a soft veto/i);
  // Criterion 3: the client is told neither the count nor the text.
  assert.doesNotMatch(flat, /reports how many carry one/i);
});

// A different case, and untouched: no reviewer at all still stops the branch.
test('the suite workflow still refuses to upload behavioral with no independent reviewer', () => {
  assert.match(flat, /If one is unavailable, do not upload the behavioral branch/i);
});
