import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflow = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../plugin/skills/unitbob/workflows/${name}.md`, import.meta.url)), 'utf8');

// a2time, 2026-08-17. The project is pinned to a Ruby the machine did not have,
// so the run set out to install one: `rbenv install 2.7.8`, then a search for a
// base image, then a survey of which package hosts the sandbox would allow. It
// never ran `suite-prepare` at all — the one command that would have said what
// this machine can run, and, on that machine, that the tests belong in a
// container. Nothing was generated and nothing reached the server.
//
// The recipes said "relay its message and stop" about a prepare that *ran and
// refused*. They said nothing about not running it, so the model filled the gap
// with the most helpful-looking thing available.
test('every workflow refuses to let the agent repair the environment', () => {
  // All four, not the two that met the failure: `check` and `fix` start the
  // project's own runner too, and a missing interpreter looks the same from
  // there. A rule that holds in half the entrances is a rule with an entrance.
  for (const name of ['map', 'suite', 'check', 'fix']) {
    assert.match(workflow(name), /The environment is never yours to repair/, `${name}.md`);
  }

  // The incident is told where the work is planned, so the rule reads as a
  // price somebody paid rather than as a preference.
  for (const name of ['map', 'suite']) {
    const text = workflow(name);
    // Named, because a general rule reads as advice and a list reads as a rule.
    assert.match(text, /interpreter/i);
    assert.match(text, /rbenv/);
    // And the one thing to do instead.
    assert.match(text, /say it to the user in its own words and stop/);
  }
});

// Spec 36 shipped the execution place — a project can say its processes run in a
// container — and then said so nowhere an agent reads. `grep -i docker` over the
// skill and every workflow answered zero: the field existed only in the text of
// a failure, on one path, in a package the agent never opens.
test('the suite workflow makes the execution place discoverable', () => {
  const text = workflow('suite');
  assert.match(text, /"exec": \{"docker": \{"container"/);
  // The invariant the whole feature rests on, in the reader's terms.
  assert.match(text, /[Ff]iles stay on the host/);
  // The container is found, never guessed: `suite-prepare` lists the ones that
  // actually have this project mounted, and picking between `web` and `worker`
  // from a name is how a suite runs somewhere nobody meant it to.
  assert.match(text, /[Nn]ever write a container name it did not name/);
});

// `placeAdvice` prints "add this line to .unitbob.json" from the `run` verb as
// well as from `suite-prepare`, so an agent can meet the container advice on the
// check and fix paths without ever opening `suite.md`. They point at it rather
// than repeat it: the same paragraph in four files is four things to keep in
// step.
test('the other workflows point at the execution place without restating it', () => {
  for (const name of ['check', 'fix']) {
    assert.match(workflow(name), /container/, `${name}.md`);
  }
});
