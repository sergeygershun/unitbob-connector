import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  assert.match(body, /emergency fuse, not a budget/i);
  assert.match(body, /preserve the supplied checkpoint and completed files/i);
  assert.match(body, /only.*owned_paths/i);
  assert.match(body, /unitbob:fact-finder/);
  assert.match(body, /never run.*suite/i);
  assert.match(body, /one final read/i);
  assert.match(body, /final read.*confirm every `facts` entry.*object/i);
});

// Spec 42, Task 0.3. The rule "a checkpoint owes `decisions` and
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
