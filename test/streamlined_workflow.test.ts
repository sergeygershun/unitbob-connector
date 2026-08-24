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

// Spec 34-6, criterion 1. The load a worker was handed was never bounded: it was
// "the whole assignment, divided", and the assignment is the whole product map.
// On a2time, 2026-08-10 that meant 8–11 capabilities each, and seven of eight
// workers wrote nothing at all. The workflow now picks the lamps before it plans
// anything, and asks the user to confirm them — the only question in the whole
// workflow worth a user's turn, because a wrong choice costs the entire run.
test('the suite workflow chooses the lamps with the user before it plans', () => {
  assert.match(flat, /Choose which lamps this build guards, before you plan anything/i);
  // Judged from what the assignment already carries, in words, with no formula
  // and no target number.
  assert.match(flat, /`title`, `description`, and the `surfaces`, `tables` and `externals` lists/i);
  assert.match(flat, /no weight formula and no target number of lamps/i);
  // The run does not move until the user answers.
  assert.match(flat, /Do not plan or fan out before the user answers/i);
  assert.match(flat, /only place in the whole workflow where a question is worth the user's turn/i);
  // Criterion 1.8: scope bounds the target, not the reading.
  assert.match(flat, /Scope bounds the target, not the reading/i);
  // Spec 37-3, criterion 2. The structural peer is chosen the same way, in the
  // same message. It used to be exempt — "never narrowed" — and that exemption
  // is what kept two thirds of a run outside the only question a user is asked:
  // on microblog, 2026-08-23, the answer reached 8 of the 15 workers that ran.
  assert.match(flat, /choose for \*\*both\*\* branches in one message/i);
  assert.match(flat, /Do the same for the structural assignment/i);
  assert.doesNotMatch(flat, /structural branch is never narrowed/i);
  // Criterion 1.5: the plan is the only record of the choice.
  assert.match(flat, /Nothing records this choice except the plan/i);
});

// The manifest the upload checks is exhaustive whatever the scope was, so a
// narrowed build has to say something about the lamps it did not guard. It says
// `unguarded`, with a reason — the one answer that is both true and accepted.
// Leaving them out is rejected at upload, after every file has been written.
test('the workflow answers the lamps outside the scope as unguarded, with a reason', () => {
  assert.match(flat, /coverage manifest you write in step 9 stays exhaustive/i);
  // Both branches, now that both can be narrowed: the structural manifest is
  // keyed by interface and is checked for exhaustiveness by the same validator.
  assert.match(flat, /every assigned capability and every assigned interface gets exactly one answer/i);
  assert.match(flat, /everything you left out is `unguarded` with a reason/i);
  assert.match(flat, /"n\/a" is not/i);
});

// Criterion 2.4. The fuse is not an outcome, and the coordinator's own document
// is where that has to be written: the workers' definitions saying it describes
// what someone else will do.
test('the coordinator reports a fired fuse as a fault of the run', () => {
  assert.match(flat, /fault of the run, not one of its outcomes/i);
  assert.match(flat, /never call its branch successful/i);
  assert.match(flat, /say in the report that the fuse fired/i);
});

// Both edges named in the requirements, so neither turns into a refusal the
// workflow never wrote down.
test('one lamp and every lamp are both legitimate answers', () => {
  assert.match(flat, /One capability is a legitimate answer/i);
  assert.match(flat, /All of them is allowed too/i);
  assert.match(flat, /so few capabilities that there is nothing to divide, do not ask/i);
});

// Spec 34-6, criterion 2. Every counter that rationed the work is gone from the
// workflow: the ceilings were cutting quality, not cost, and the run they were
// meant to protect died inside them.
test('the suite workflow states no budget, no worker ceiling and no lookup ceiling', () => {
  assert.doesNotMatch(flat, /`budget`/);
  assert.doesNotMatch(flat, /budget\.workers/);
  assert.doesNotMatch(flat, /review_rounds|repair_rounds/);
  assert.doesNotMatch(flat, /1\.5 times/);
  assert.doesNotMatch(flat, /3–6 scenarios|more than 8 requires/i);
  assert.doesNotMatch(flat, /no more than \*\*eight\*\* lookups/i);
  // The worker ceiling is back, and deliberately: spec 37-3 replaced "no ceiling
  // at all" with one measured from the work. What stays gone is the *budget* —
  // a number the server sent and nothing could check. This one is measured on
  // the vibecoder's own disk, by the same command that built the packets.
  assert.doesNotMatch(flat, /no ceiling on how many workers a branch gets/i);
  assert.match(flat, /decided by how many cases they will write/i);
});

// Criterion 4, and spec 37-2 criterion 1. Every checkpoint exists before fan-out
// and carries the facts the coordinator verified — on 2026-08-10 the same list
// was assembled by hand halfway through the run, and the packets that received
// it finished completely. The document itself is seeded by `accept-worker-plan`
// now; what the coordinator adds to it is the facts, and only the facts.
test('every checkpoint is seeded before fan-out, and the coordinator adds only its facts', () => {
  assert.match(flat, /Do not write those files yourself/i);
  assert.match(flat, /Add what you established about this project to the checkpoints step 5 seeded/i);
  assert.match(flat, /source_refs/);
  const seeding = flat.indexOf('accept-worker-plan');
  const fanOut = flat.indexOf("Start a branch's workers together");
  assert.ok(seeding >= 0 && fanOut > seeding, 'checkpoints are seeded before the fan-out');
});

// Criterion 3. The one thing left that can end a repair loop, and it stops the
// branch rather than a worker: the set of failures belongs to the branch.
test('the suite workflow reads a repeated failure set as the stop signal', () => {
  assert.match(flat, /remembers each branch's set of failures between runs/i);
  assert.match(flat, /exits non-zero/i);
  assert.match(flat, /stops the branch, not one worker/i);
  assert.match(flat, /never as a reason to run it again unchanged/i);
});

// Criterion 6. On autobrella the fan stood on review, where the work is
// mechanical, and was missing from generation, where the work is reading code —
// one agent took 63 capabilities and wrote the last third without reading the
// sources.
test('the suite workflow puts a bounded fan-out where the reading is', () => {
  assert.match(flat, /`unitbob:suite-worker`/i);
  assert.match(flat, /always exactly one reviewer/i);
  assert.match(flat, /fresh named repair role/i);
  assert.match(flat, /`unitbob:suite-repair-worker`.*`suite-repair-worker`/i);
  assert.doesNotMatch(flat, /continuation of its own context/i);
});

// Spec 37-3, criterion 1. 34-3 said splitting never loses, on the argument that
// an agent re-reads its context every turn so only the variable half of its cost
// divides. The measurement of 2026-08-24 says the fixed half is the whole story:
// a worker's opening context is 26,065 tokens (±370 across fifteen), it is
// bought per worker rather than divided, and the entire run's work was 39,652
// tokens — less than two of those preambles, spread over fifteen.
test('the suite workflow sizes the fan by the work and creates only non-empty slices', () => {
  assert.match(flat, /How many workers a branch gets is decided by how many cases they will write/i);
  // Both ends of the curve, because naming only the ceiling is what produced the
  // first draft of this rule — which would have collapsed the behavioral branch
  // to one 216-turn worker against a 150-turn fuse.
  assert.match(flat, /the fewest worth planning, not the target/i);
  assert.match(flat, /Then plan wider than that, because a run is waited on/i);
  assert.match(flat, /One slice per capability is a fine answer/i);
  // Only the narrow end is refused; wall clock only ever improves with width.
  assert.match(flat, /That is the one end `accept-worker-plan` refuses/i);
  // Bytes are measured and printed, and deliberately do not set the width.
  assert.match(flat, /Not by how much source there is to read/i);
  assert.match(flat, /never create an empty slice/i);
  // Judging the width by eye is the thing being replaced, so it is named.
  assert.match(flat, /do not judge the width by how complicated the business looks/i);
  assert.doesNotMatch(flat, /Balance visible business complexity/i);
});

// Same criterion, and nothing in the plugin used to say it: `parallel`,
// `concurrently` and `simultaneously` appeared nowhere in it. A fan launched one
// worker at a time costs the same and finishes later.
test("the suite workflow starts a branch's workers in one go", () => {
  assert.match(flat, /Start a branch's workers together, in one go/i);
  assert.match(flat, /Sequential slices save nothing and finish later/i);
  // Twice the workers is not permission to run the shared test database twice.
  assert.match(flat, /never run the suite themselves/i);
  // Spec 37-3, criterion 3. "In one go" was already here and both measured runs
  // broke it the same way, launching one worker per message. The rule now says
  // what one go is, and what it cost not to: on microblog, 2026-08-23, the 15
  // launch turns were 3.54M tokens and bought nothing — the workers ran
  // concurrently regardless, 14 at once. The 15 return turns are a further 3.57M
  // and cannot be declined, so the rule there is the opposite one: owe a
  // returned slice nothing.
  assert.match(flat, /\*\*In one go means one message\.\*\*/i);
  assert.match(flat, /a single message carrying one launch per slice/i);
  assert.match(flat, /the workers ran concurrently either way/i);
  assert.match(flat, /Then wait for the branch, not for each worker/i);
  assert.match(flat, /You cannot decline those turns/i);
  assert.match(flat, /One report, once the branch is in/i);
});

// The fact-finder's ceilings are frontmatter, so they hold whatever the session
// is. Workers have no definition file — the coordinator launches them — so an
// unnamed model is the session's, and the 72 % of a run they account for would
// silently follow whichever model the operator opened their terminal on. Only
// the cheap 11 % was pinned; this pins the expensive part too.
test('the suite workflow uses host-specific named workers whose definitions own model and ceiling', () => {
  assert.match(flat, /named role.*`unitbob:suite-worker`.*`suite-worker`/i);
  assert.match(flat, /host-specific definition owns the cheaper model and the emergency turn fuse/i);
  assert.match(flat, /never continue/i);
});

// Spec 34-3, criterion 1, with its ceiling removed by 34-6, criterion 2.1. The
// need the named role answers is unchanged — a worker may not run anything, so
// it either looks the factory's arguments up or invents them — and naming the
// role is the whole mechanism, because the host's default agent has no ceilings
// at all. What is gone is the cap of eight: a direct limit on how many facts a
// worker was allowed to be sure of.
test('the suite workflow sends workers to the named fact-finder, uncapped', () => {
  assert.match(flat, /`unitbob:fact-finder`/);
  assert.match(flat, /as many closed lookups as the work needs/i);
  assert.match(flat, /no ceiling on model, turn count, or answer length/i);
  assert.match(flat, /Closed questions with the files to look in/i);
});

// Criterion 4.3. The old order — create the checkpoint, read the sources, then
// write — put research before any output at all, and on 2026-08-10 seven of
// eight workers spent their whole ceiling inside it.
test('workers write from the seeded facts before they go looking', () => {
  assert.match(flat, /start by writing what the seeded facts already support/i);
  assert.doesNotMatch(flat, /create the checkpoint before source research/i);
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
  const planGate = flat.indexOf('accept-worker-plan');
  const fanOut = flat.indexOf("Start a branch's workers together");
  // The checkpoint gate is run twice now, and both runs are asserted: once on the
  // seeds, where a refusal costs seconds rather than sixteen already-launched
  // workers, and once after fan-out, which is the run standing between a stale
  // checkpoint and repair.
  const seedGate = flat.indexOf('validate-worker-checkpoints');
  const checkpointGate = flat.lastIndexOf('validate-worker-checkpoints');
  assert.ok(planGate >= 0 && fanOut > planGate);
  assert.ok(seedGate >= 0 && seedGate < fanOut);
  assert.ok(checkpointGate > fanOut);
  assert.match(flat, /If it exits non-zero.*stop before fan-out/i);
});

// Still finite where finiteness is about not reusing an exhausted context. Spec
// 34-6, criterion 2.1 removes the two counts that were about rationing work
// instead: one planning pass (replanning after the first slice is cheap and
// legitimate) and one shared-harness correction (the second real harness problem
// used to kill the branch).
test('the coordinator workflow is finite where it matters and no longer rations planning', () => {
  assert.match(flat, /one fresh repair rotation/i);
  assert.match(flat, /exactly one final run/i);
  assert.match(flat, /Replanning after the first slice comes back is legitimate/i);
  assert.doesNotMatch(flat, /one planning pass/i);
  assert.doesNotMatch(flat, /at most one host-owned shared harness correction/i);
  assert.doesNotMatch(flat, /continue (?:the )?(?:coordinator|worker).*context/i);
});

test('repair packets run sequentially and validate owned cases before one final run', () => {
  assert.match(flat, /repair packets sequentially/i);
  // Anchored on the loop itself, then on the permission to repeat it. The
  // earlier form asked for `repeat` first and was satisfied by an unrelated
  // "workers do not repeat it locally" several steps above — passing, but never
  // for its own reason.
  assert.match(flat, /edit → run-local <branch> → inspect.*may repeat that loop/i);
  assert.match(flat, /only.*owned paths.*case markers/i);
  assert.match(flat, /does not require.*green.*whole branch/i);
  assert.match(flat, /after all.*repair packets.*exactly once as the final run/i);
  assert.doesNotMatch(flat, /run repair packets (?:together|in parallel)/i);
});

// Spec 35-1, criterion 3. Sequential repair produces no output for tens of
// minutes at a time, and five such packets in a row are indistinguishable from a
// hung process — which is exactly how one run was read. The coordinator already
// knows the sequence; this only makes it say it.
test('the coordinator names each repair packet before it starts and after it returns', () => {
  assert.match(flat, /repair 3\/7: bh-agency-solo-sales/);
  assert.match(flat, /repair 3\/7: bh-agency-solo-sales — 48 scenarios green/);
  assert.match(flat, /one line before launching a packet and one line after it returns/i);
  // The count is the packets that were actually built, not a guess.
  assert.match(flat, /number after the slash is the count of failure packets you actually built/i);
  // Nothing new is introduced to carry it: no bar, no clock, no file.
  assert.match(flat, /No progress bar, no timer, no estimate/i);
  assert.doesNotMatch(flat, /persisted progress|progress file/i);
});

test('partial checkpoints enter the same executable repair loop', () => {
  assert.match(flat, /unresolved_promises.*without.*initial.*failure/i);
  assert.match(flat, /complete.*unresolved_promises.*first/i);
  assert.match(flat, /then.*run-local <branch>/i);
});

test('repair keeps owned ambiguity and unfinished harness work out of product reds', () => {
  assert.match(flat, /ambiguous.*build_error/i);
  assert.match(flat, /shared harness.*build_error/i);
  assert.match(flat, /product defect.*business contract.*production source/i);
  assert.match(flat, /no strict JSON/i);
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
