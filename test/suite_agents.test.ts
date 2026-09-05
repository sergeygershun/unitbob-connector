import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STRUCTURAL_SETUP_FILE } from '../src/runner/vitest.ts';

function workflow(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../plugin/skills/unitbob/workflows/${name}.md`, import.meta.url)), 'utf8');
}

function agent(name: string): { frontmatter: string; body: string } {
  const text = readFileSync(fileURLToPath(new URL(`../plugin/agents/${name}.md`, import.meta.url)), 'utf8');
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  return { frontmatter, body: text.slice(text.indexOf('\n---\n', 3) + 5).replace(/\s+/g, ' ') };
}

// Spec 34-6, criteria 2.4 and 4.3. The ceiling is a fuse now — 150 turns, far
// above what one plan item takes — and the worker no longer opens by reading:
// its checkpoint arrives seeded, and it writes what those facts already support
// before it goes looking for anything.
test('suite-worker has an emergency 150-turn Sonnet fuse and one plan-item contract', () => {
  const { frontmatter, body } = agent('suite-worker');
  assert.match(frontmatter, /^name: suite-worker$/m);
  assert.match(frontmatter, /^model: sonnet$/m);
  assert.match(frontmatter, /^maxTurns: 150$/m);
  assert.match(body, /exactly one worker-plan item/i);
  assert.match(body, /checkpoint already exists/i);
  assert.match(body, /never initialize it again/i);
  assert.match(body, /Write first, then find out/i);
  assert.match(body, /fact already in your checkpoint is settled/i);
  // …and the one exception, without which "settled" reads as "true". a2time,
  // 2026-08-17: a seeded fact read from memory went to sixteen workers as
  // verified, and the run was saved by the one worker that checked it anyway.
  assert.match(body, /`read` fact/i);
  assert.match(body, /`known_problems`/);
  assert.match(body, /emergency fuse, not a budget/i);
  assert.match(body, /preserve the supplied checkpoint and completed files/i);
  assert.match(body, /only.*owned_paths/i);
  assert.match(body, /unitbob:fact-finder/);
  assert.match(body, /never run.*suite/i);
  assert.match(body, /one final read/i);
  assert.match(body, /final read.*confirm every `facts` entry.*object/i);
});

// Spec 43, Task 0.3. The rule "a checkpoint owes `decisions` and
// `known_problems`" lived in one line of `validateWorkerCheckpoints.ts` and
// nowhere a worker or a coordinator can read it. Three runs paid for that in
// rejected checkpoints — about thirty on one of them, plus a hand-written
// normalizer to get past the gate. The rule now sits where the checkpoint is
// written: on both hosts, and in the workflow that seeds it.
test('every place a checkpoint is written names the keys the gate requires', () => {
  const workflow = readFileSync(
    fileURLToPath(new URL('../plugin/skills/unitbob/workflows/suite.md', import.meta.url)),
    'utf8',
  );
  const codexWorker = readFileSync(
    fileURLToPath(new URL('../plugin/codex/agents/suite-worker.toml', import.meta.url)),
    'utf8',
  );

  for (const text of [agent('suite-worker').body, workflow, codexWorker]) {
    assert.match(text, /`decisions`/);
    assert.match(text, /`known_problems`/);
  }
  assert.match(workflow, /"decisions": \[\], "known_problems": \[\]/);
});

// a2time, 2026-08-17. The published metadata owes the server one entry per
// Scenario naming the addresses that Scenario drives, and nothing in the handoff
// carried it: the coordinator wrote it from the workers' closing prose and from
// its own plan, the reviewer read the step files, and the two disagreed on six
// Scenarios. The worker writes the steps, so the worker records what they drive —
// and the coordinator copies rather than interprets.
test('the worker records what its Scenarios drive, and the coordinator copies that', () => {
  const { body } = agent('suite-worker');
  const text = workflow('suite');
  const stepNine = text.slice(text.indexOf('\n9. '), text.indexOf('\n10. '));

  assert.match(body, /`surface_coverage`/);
  assert.match(body, /exact Scenario name/i);
  assert.match(body, /capability_id/);
  assert.match(stepNine, /`surface_coverage`/);
  assert.match(stepNine, /from the checkpoints/i);
  // The status half of the same rule: what a coordinator may not do instead.
  assert.match(stepNine, /never search the generated files for a marker/i);
});

// Spec 41, criterion 1. The other bucket a worker fills, held to the same chain:
// only the worker that tried to drive an address knows nothing can, and the value
// of knowing dies at the checkpoint unless the coordinator carries it up. A field
// written, gated, and read by the map but never copied into the upload is a field
// with no reader at all — which is what 44 refuses to let anyone introduce.
test('the worker records an address nothing can drive, and the coordinator carries it up', () => {
  const { body } = agent('suite-worker');
  const text = workflow('suite');
  const stepNine = text.slice(text.indexOf('\n9. '), text.indexOf('\n10. '));

  assert.match(body, /`unreachable_surfaces`/);
  assert.match(body, /nothing you can do\*{0,2} makes that request happen/i);
  // And the half that is now nobody's job to write down.
  assert.match(body, /do \*{0,2}not\*{0,2} list the addresses you simply did not take/i);
  assert.match(stepNine, /unreachable_surfaces.*copy through/is);
  assert.match(stepNine, /not taken this time/i);
});

// The seeded checkpoint is where both halves start, so the shape is stated where
// it is written — the lesson `decisions` and `known_problems` already taught,
// and the seed example is the part a reader copies.
test('the seed names the behavioral join and says how a seeded fact was established', () => {
  const text = workflow('suite');
  const stepSix = text.slice(text.indexOf('\n6. '), text.indexOf('\n7. '));

  assert.match(stepSix, /"surface_coverage": \[\]/);
  assert.match(stepSix, /"unreachable_surfaces": \[\]/);
  assert.match(stepSix, /"established_by"/);
  assert.match(stepSix, /ran: /);
  assert.match(stepSix, /Nothing you\s+remember about this project is a fact/i);
  // And the gate runs here, where a rejected seed costs seconds — not after
  // fan-out, where it costs every worker the run just launched.
  assert.match(stepSix, /validate-worker-checkpoints/);
});

// Spec 44, §1.1–1.5. Two runs out of four lost an hour each to roles the session
// could not see, and both found out only at fan-out: a2time after the map, the
// plan and 18 seeded checkpoints; noahsat-web after a full behavioral branch it
// then had to throw away. The check costs seconds, so it stands at the top of
// both workflows — `map` because that is where the hour went, `suite` because a
// project whose map already exists starts there and never passes through `map`.
//
// Asserted against the text before step 1, in both files, so that "it is checked
// somewhere" cannot pass for "it is checked before anything is spent".
test('both workflows ask the reviewer role for a word before they spend anything', () => {
  for (const name of ['map', 'suite']) {
    const text = workflow(name);
    const beforeFirstStep = text.slice(0, text.indexOf('\n1. '));
    assert.ok(beforeFirstStep.length > 0, `${name}.md has no step 1 to stand in front of`);

    assert.match(beforeFirstStep, /`unitbob:suite-reviewer` \(Claude Code\) or `suite-reviewer`\s+\(Codex\)/);
    assert.match(beforeFirstStep, /single word READY/);
    assert.match(beforeFirstStep, /read\s+nothing, write nothing, run nothing/);
    // One role, with the reason in the step itself — otherwise the next reader
    // "completes" it to four and pays four times for one answer.
    assert.match(beforeFirstStep, /One role is checked, not four/);
    assert.match(beforeFirstStep, /reviewer you can never stand in for/);

    // The registry-missed-it diagnosis, and the one action that fixes it.
    assert.match(beforeFirstStep, /no such agent type/);
    assert.match(beforeFirstStep, /Restart the session \(Claude Code\) or open a new task \(Codex\)/);
    assert.match(beforeFirstStep, /Nothing on disk is lost/);
    // And the other branch of the diagnosis: a role that is found and fails is
    // not a stale session, and sending the user to restart costs them the rest
    // of it for nothing.
    assert.match(beforeFirstStep, /means the role itself failed/);
    assert.match(beforeFirstStep, /\*\*do not\*\* advise a restart/i);
  }
});

// §1.5. The check is repeated immediately before fan-out, because a run need not
// stay in one session and step 7 launches every worker at once.
//
// The Codex disk check that already lived there is kept, and kept *distinct*:
// it looks at `~/.codex/agents/`, and files sitting on disk are exactly what
// both lost runs had. Calling it the third role check — which this file did for
// a draft — would have pinned that confusion in a test.
test('suite asks the role again immediately before fan-out, and keeps the disk check apart from it', () => {
  const fanOut = workflow('suite').slice(workflow('suite').indexOf('\n7. '));

  assert.match(fanOut, /repeat step 0.s check/i);
  assert.match(fanOut, /`unitbob:suite-reviewer` on\s+Claude Code, `suite-reviewer` on Codex/);
  assert.match(fanOut, /must also be discoverable on disk in\s+`~\/\.codex\/agents\/`/);
  assert.match(fanOut, /different question from the one above/);
  assert.match(fanOut, /unitbob@\d+\.\d+\.\d+ codex-install/);
});

// §3.2. The step that tells the coordinator what to read out of `request.json`
// has to name `step_loading`, or nothing does: the recipe stopped retelling the
// runner's rule, and `suite-prepare`'s notice scrolls past several steps before
// the first step file is written.
test('the step that reads request.json names the rule for step filenames', () => {
  const text = workflow('suite');
  const stepTwo = text.slice(text.indexOf('\n2. '), text.indexOf('\n3. '));

  assert.match(stepTwo, /`step_loading`/);
  assert.match(stepTwo, /`step_files`/);
  assert.match(stepTwo, /`requirements`/);
  assert.match(stepTwo, /capability_id.{0,40}where the `\*` is/s);
  assert.match(stepTwo, /Do not look this up in the\s+connector.s source/);
});

// Spec 39. The shared setup file is an agreement by name and nothing else — no
// protocol field carries it — so the name is written down in three places across
// two repositories: this constant, the step that tells the coordinator to write
// the file, and the structural recipe that tells a worker to leave it alone. A
// rename reaching only one of them breaks in silence: the file would be written,
// published, and then never put in front of the imports. This guards the two
// halves that live in this repository; the recipe's copy is guarded on the brain
// side, in `spec/prompts/recipe_content_spec.rb`.
test('the workflow tells the coordinator to write the exact file the connector looks for', () => {
  const text = workflow('suite');
  const stepOneA = text.slice(text.indexOf('\n1a. '), text.indexOf('\n2. '));

  assert.ok(text.includes(STRUCTURAL_SETUP_FILE), 'the workflow spells the name the connector knows');
  assert.match(stepOneA, /before you plan anything/i);
  // Written by the coordinator and not by a worker, which is the whole reason
  // this branch's shared file is unlike its peer's.
  assert.match(stepOneA, /author is you, not a worker/i);
  // The minimum rule, and the last-resort clause that protects epic-stack's 50.
  assert.match(stepOneA, /minimum the probe needs/i);
  assert.match(stepOneA, /last resort/i);
  // Always written, never empty — the server refuses empty content along with
  // the whole branch, after every worker has finished.
  assert.match(stepOneA, /always, even when there is nothing to prepare/i);
  assert.match(stepOneA, /never leave it\s+empty/i);
  // The second ask, its one deadline, and the correction that is not a loop.
  assert.match(stepOneA, /run `suite-prepare` again/i);
  assert.match(stepOneA, /before step 4 writes/i);
  assert.match(stepOneA, /one correction, not a loop/i);
  // And where it does not apply, so nobody writes a `.ts` file beside a Gemfile.
  assert.match(stepOneA, /Skip all of this on Ruby and Python/i);

  // It has to be listed in the answer, or the next materialization wipes it.
  const stepNine = text.slice(text.indexOf('\n9. '), text.indexOf('\n10. '));
  assert.ok(stepNine.includes(STRUCTURAL_SETUP_FILE), 'the assembly step names it too');
  assert.match(stepNine, /support_files/);

  // And it is repaired by its one owner, never handed out in a repair packet —
  // said where the failures are being divided up, which is where that decision
  // is actually made.
  const stepEleven = text.slice(text.indexOf('\n11. '), text.indexOf('\n12. '));
  assert.ok(stepEleven.includes(STRUCTURAL_SETUP_FILE), 'the step that assigns failures names it');
  assert.match(stepEleven, /put it in no repair\s+packet/i);
});

test('suite-repair-worker validates its owned slice within a 150-turn fuse', () => {
  const { frontmatter, body } = agent('suite-repair-worker');
  assert.match(frontmatter, /^name: suite-repair-worker$/m);
  assert.match(frontmatter, /^model: sonnet$/m);
  assert.match(frontmatter, /^maxTurns: 150$/m);
  assert.match(body, /one failure packet/i);
  assert.match(body, /facts.*come to you established/i);
  assert.match(body, /do not go and find them out again/i);
  assert.match(body, /exits non-zero when the branch comes back with exactly the failures/i);
  assert.match(body, /unresolved_promises.*first/i);
  assert.match(body, /do not expand/i);
  // Version-agnostic on purpose: `plugin_pins.test.ts` already guards that every
  // pinned version in this repository is the same one, and repeating the number
  // here only meant a release bump had to remember to visit a test about turn
  // fuses.
  assert.match(body, /npx -y --loglevel=error unitbob@\d+\.\d+\.\d+ run-local <branch>/i);
  assert.match(body, /repeat.*edit.*run-local.*inspect/i);
  assert.match(body, /owned paths.*case markers/i);
  assert.match(body, /do not require.*green.*branch/i);
  assert.match(body, /runner setup.*helpers.*factories/i);
  assert.match(body, /do not run.*project.*suite/i);
  assert.match(body, /production code.*shared.*another slice/i);
  assert.match(body, /skip.*pending.*todo/i);
  assert.match(body, /ambigu.*build_error/i);
  assert.match(body, /business contract.*production source/i);
  assert.match(body, /final read.*confirm every `facts` entry.*object/i);
});

// Spec 35-1, criterion 4, under spec one-place-per-rule. The full scope of
// verdicts — including the capabilities the finite plan left outside the chosen
// scope — is stated in the brain prompt that owns this review. A copy here would
// be a second home for a rule with one owner, which is how the local marker
// check drifted from the server's and had to be removed.
test('the reviewer agent points at the review request and does not re-tell the brain rule about scope', () => {
  const { body } = agent('suite-reviewer');

  assert.match(body, /one entry per assigned capability/i);
  assert.doesNotMatch(body, /outside the chosen scope/i);
  assert.doesNotMatch(body, /without reading Scenarios/i);
  assert.doesNotMatch(body, /fifty-six|56 capabilit/i);
});
