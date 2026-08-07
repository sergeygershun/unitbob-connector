// Spec 34-3, criterion 1. On the autobrella run of 2026-08-07, four budgeted
// workers had 36 agents running under them: lookup agents nobody had ordered.
// Neither recipe nor workflow mentioned such a thing — `subagent` appears once
// in the whole plugin, and that once is about the reviewer — so every one of
// them was the model's own idea. They came to $140, 11 % of the run, because
// they went to the costliest model with no ceiling on turns; the longest ran
// 109 and one answered with 78,000 characters.
//
// The need behind them is real: a worker may not run anything, so it either
// looks a factory's arguments up or guesses them. So this agent exists, with
// ceilings. The ones that can be mechanical live in the frontmatter and hold
// whatever the coordinator puts in the prompt; the ones that cannot — do not
// run the suite, quote rather than paste — are prose in the body and pinned
// here so they cannot quietly leave it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const agent = readFileSync(
  fileURLToPath(new URL('../plugin/agents/fact-finder.md', import.meta.url)),
  'utf8',
);

const frontmatter = agent.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
const body = agent.slice(agent.indexOf('\n---\n', 3) + 5);
// The body is hard-wrapped, so match sentences against a flattened copy rather
// than letting a re-wrap slip a rule past its guard.
const flat = body.replace(/\s+/g, ' ');

test('the fact-finder carries its ceilings in frontmatter, where a prompt cannot argue with them', () => {
  assert.match(frontmatter, /^name: fact-finder$/m);
  // Extraction billed as reasoning was the single largest thing wrong with the
  // measured lookups: the workers ran on Sonnet and their lookups on Opus.
  assert.match(frontmatter, /^model: sonnet$/m);
  assert.match(frontmatter, /^maxTurns: 30$/m);
  // It reads and reports; it has no reason to touch the project.
  assert.match(frontmatter, /^disallowedTools: Write, Edit, NotebookEdit$/m);
});

// An accepted risk, not an oversight, and it is worth knowing which. The tool
// that launches a subagent is called `Agent`, so `disallowedTools: Agent` would
// work and would flatten the fan. It stays off until a measurement shows the
// nesting costs more than it returns — a worker that cannot delegate a lookup
// makes the coordinator guess in advance what four workers will need.
test('the fact-finder is not forbidden to delegate, and does not pin an effort level', () => {
  assert.doesNotMatch(frontmatter, /\bAgent\b/);
  assert.doesNotMatch(frontmatter, /^effort:/m);
});

test('the fact-finder answers in excerpts, not files', () => {
  assert.match(flat, /Quote, don't summarise/i);
  assert.match(flat, /Excerpts, never whole files/i);
  // The rule is worth nothing if a worker can ask its way out of it, and on the
  // measured run that is exactly the shape the expensive answers arrived in.
  assert.match(flat, /even when you are asked for a whole file/i);
  // A gap reported is an answer; a plausible factory name is a red round.
  assert.match(flat, /Never fill a gap with what a project of this shape usually has/i);
});

// The test database is shared and the coordinator owns every run of it. Workers
// are already forbidden to run the suite; a lookup agent with `Bash` is the door
// that leaves open, and on the measured run one went through it and reported
// that it had tidied up afterwards.
test('the fact-finder does not run the suite, and knows the rule is its own to keep', () => {
  assert.match(flat, /Do not run the suite and do not boot the application/i);
  assert.match(flat, /`Bash` stays open because reading and searching need it/i);
  assert.match(flat, /this rule is yours to keep/i);
});

test('the fact-finder reports facts and leaves the test design to the worker', () => {
  assert.match(flat, /Do not reason about how to write the test/i);
  // Thirty turns can run out, and what the worker gets is whatever was said by
  // then — so say it as you go.
  assert.match(flat, /report each fact as you confirm it/i);
});
