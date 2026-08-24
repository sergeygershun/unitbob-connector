import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { branchWidth, branchWorkloads, turnsAt } from '../src/files/fanOut.ts';
import { readWorkerPlan, takenIds, validateWorkerPlanFiles, workerPlanPath } from '../src/files/workerPlan.ts';
import { MAX_PACKET_BYTES, PACKETS_DIR, packetIndexPath, type PacketTarget } from '../src/files/packets.ts';

// Spec 37-3, criterion 1. An agent's cost is the sum of its context over its
// turns, so splitting pulls two ways: the opening context multiplies with the
// width, and each conversation gets shorter, which pays off with the square of
// its length. There is a minimum, and it is neither end.
//
// Measured on microblog, 2026-08-24, against what fifteen workers really cost:
// 1 worker 51.2M, 2 → 34.6M, 5 → 27.7M, 8 → 28.8M, 15 → 35.6M. That run planned
// 35 behavioral cases over 8 workers and 91 structural cases over 7; the cheapest
// widths for those are 4 and 2.

interface Fixture {
  branch?: string;
  slices?: number;
  cases?: number;
  files?: number[];
  unresolved?: number;
  overFuse?: number;
  bytesAs?: unknown;
}

function project(fixture: Fixture = {}): string {
  const {
    branch = 'structural', slices = 1, cases = slices, files = [], unresolved = 0, overFuse, bytesAs,
  } = fixture;
  const root = mkdtempSync(join(tmpdir(), 'unitbob-fan-out-'));
  mkdirSync(join(root, '.unitbob', 'suite-build'), { recursive: true });
  const ids = Array.from({ length: slices }, (_, index) => `i${index + 1}`);
  const assignment = branch === 'behavioral'
    ? { capabilities: ids.map((id) => ({ capability_id: id })) }
    : { blocks: [{ block_id: 'one', interfaces: ids.map((id) => ({ interface_id: id })) }] };
  const requestBytes = `${JSON.stringify({
    project_root: root,
    output_path: join(root, '.unitbob/suite-build/suite_output.json'),
    branches: [{ suite_kind: branch, assignment }],
  }, null, 2)}\n`;
  writeFileSync(join(root, '.unitbob/suite-build/request.json'), requestBytes);

  const targets: PacketTarget[] = [
    ...files.map((bytes, index) => ({
      branch, id: ids[0], entrypoint: `Thing#f${index}`,
      packet: `${PACKETS_DIR}/app/f${index}.py`,
      // `in`, not `??`: null is one of the values under test.
      bytes: ('bytesAs' in fixture ? bytesAs : bytes) as number,
    })),
    ...(overFuse === undefined ? [] : [{
      branch, id: ids[0], entrypoint: 'Huge#create',
      source_file: 'app/huge.rb', bytes: overFuse, note: 'over the packet fuse',
    }]),
    ...Array.from({ length: unresolved }, (_, index) => ({
      branch, id: ids[0], entrypoint: `Lost#g${index}`, note: 'nothing answers to this name',
    })),
  ];
  if (targets.length > 0) {
    mkdirSync(join(root, PACKETS_DIR), { recursive: true });
    writeFileSync(packetIndexPath(root), `${JSON.stringify({ targets }, null, 2)}\n`);
  }

  // Cases spread as evenly as they go, remainder onto the first slice.
  const per = Math.floor(cases / slices);
  writeFileSync(workerPlanPath(root), `${JSON.stringify({
    request_digest: createHash('sha256').update(requestBytes).digest('hex'),
    workers: ids.map((id, index) => {
      const mine = per + (index === 0 ? cases - per * slices : 0);
      return {
        branch, worker_id: `s${index + 1}`, capability_ids: [id],
        promises: [`promise ${id}`],
        planned_cases: Array.from({ length: Math.max(1, mine) }, (_, c) => `case ${index}-${c}`),
        source_paths: ['app/thing.py'], owned_paths: [`.unitbob/${branch}/s${index + 1}_spec.rb`],
        harness_path: branch === 'behavioral'
          ? '.unitbob/behavioral/step_definitions/00_unitbob_world.rb'
          : '.unitbob/structural/unitbob_helper.rb',
        done_when: 'All planned cases are written and checkpointed.',
      };
    }),
  }, null, 2)}\n`);
  return root;
}

const onlyError = (root: string): string => {
  const errors = validateWorkerPlanFiles(root);
  assert.equal(errors.length, 1, errors.join('\n') || 'expected exactly one error, got none');
  return errors[0];
};

// What the rule says about the run it was measured on.

test('the cheapest width for the measured behavioral branch is four', () => {
  const width = branchWidth('behavioral', 35)!;

  assert.equal(width.workers, 4);
  // The cheapest width is also the narrowest allowed. Nothing above it is
  // refused: wall clock only improves with width, and a run is waited on.
  assert.equal(width.fewest, 4);
});

test('the cheapest width for the measured structural branch is two', () => {
  const width = branchWidth('structural', 91)!;

  assert.equal(width.workers, 2);
  assert.equal(width.fewest, 2);
});

test('a worker gets shorter as the fan gets wider, which is why wide is never refused', () => {
  // On the bench, six workers of 53 turns took 13 minutes where fifteen of 38
  // took 8 — a longer conversation is both more turns and slower turns.
  assert.ok(turnsAt('behavioral', 35, 8) < turnsAt('behavioral', 35, 4));
  assert.ok(turnsAt('behavioral', 35, 4) < turnsAt('behavioral', 35, 1));
});

test('a branch is measured in the turns its cases take, not in the bytes it reads', () => {
  // The same case count costs 5x the turns on one branch as on the other, which
  // is why bytes cannot set the width: on the measured run the branch with three
  // times the source spent half the turns.
  assert.ok(branchWidth('behavioral', 40)!.workers > branchWidth('structural', 40)!.workers);
});

// What the gate does with it.

test('a fan wider than the cheapest width is never refused', () => {
  // Eight ran on the bench and cost 43% more than four would have. It is still
  // accepted, and deliberately: it finished in half the wall clock.
  assert.deepEqual(validateWorkerPlanFiles(project({ branch: 'behavioral', slices: 8, cases: 35 })), []);
});

test('everything at or above the cheapest width passes', () => {
  for (const slices of [4, 5, 6, 7, 8]) {
    assert.deepEqual(
      validateWorkerPlanFiles(project({ branch: 'behavioral', slices, cases: 35 })), [],
      `${slices} slices for 35 cases should pass`,
    );
  }
});

test('everything below it is refused, and told how much longer that worker runs', () => {
  for (const slices of [1, 2, 3]) {
    const error = onlyError(project({ branch: 'behavioral', slices, cases: 35 }));
    assert.match(error, /is too narrow/);
    assert.match(error, /4 is the cheapest width and the fewest worth planning/);
    assert.match(error, /Wider than 4 is allowed and finishes sooner/);
  }
});

test('a small branch is one worker and nobody is refused for it', () => {
  assert.deepEqual(validateWorkerPlanFiles(project({ branch: 'structural', slices: 1, cases: 3 })), []);
  assert.equal(branchWidth('structural', 3)!.workers, 1);
});

test('a branch this connector has no measured cost for is not gated', () => {
  assert.equal(branchWidth('mutation', 400), undefined);
  assert.equal(branchWidth('structural', 0), undefined);
});

// Bytes still measured, still printed, still not the width. Everything below was
// found by review of the first draft, when bytes did set the width and each of
// these read as "no work" — which made the ceiling tighter exactly where the
// work was heaviest.

test('a file too large to carry is the heaviest reading there is, not none of it', () => {
  const root = project({ files: [50_000], overFuse: MAX_PACKET_BYTES + 1 });
  const load = branchWorkloads(root, takenIds(readWorkerPlan(root)))[0];

  assert.equal(load.files, 2, 'a file with a size is a file, packet or no packet');
  assert.equal(load.bytes, 50_000 + MAX_PACKET_BYTES + 1);
});

test('an entrypoint nothing resolved is priced at what the branch averages', () => {
  const root = project({ files: [40_000, 40_000], unresolved: 2 });
  const load = branchWorkloads(root, takenIds(readWorkerPlan(root)))[0];

  assert.equal(load.unmeasured, 2);
  // Two measured files at 40,000 each, plus two unresolved at that average.
  assert.equal(load.read_tokens, Math.round((40_000 * 4) / 4));
});

test('a branch with nothing but unresolved entrypoints is measured by nothing', () => {
  const root = project({ unresolved: 3 });

  assert.deepEqual(branchWorkloads(root, takenIds(readWorkerPlan(root))), []);
});

test('a size that is not a byte count is a size we do not have, never a zero', () => {
  for (const bytesAs of ['40000', null, Number.POSITIVE_INFINITY, -1, {}]) {
    const root = project({ files: [40_000, 40_000], bytesAs });

    assert.deepEqual(
      branchWorkloads(root, takenIds(readWorkerPlan(root))), [],
      `bytes as ${JSON.stringify(bytesAs)} should measure nothing`,
    );
  }
});

test('the workload counts a shared file once, not once per entrypoint', () => {
  const root = project({ files: [40_000] });
  const load = branchWorkloads(root, takenIds(readWorkerPlan(root)))[0];

  assert.equal(load.files, 1);
  assert.equal(load.bytes, 40_000);
});

test('work belonging to ids the plan did not take is not counted against it', () => {
  // Criterion 2 lets both branches be narrowed, and the packets are built from
  // the whole assignment before anybody chooses a scope. Weighing all of them
  // against a narrowed plan would measure a job nobody is doing.
  // One file so the fixture creates the packets folder; the index below replaces
  // what it wrote, spreading the reading across two ids instead of one.
  const root = project({ slices: 2, cases: 2, files: [1] });
  writeFileSync(packetIndexPath(root), `${JSON.stringify({ targets: [
    { branch: 'structural', id: 'i1', entrypoint: 'A#a', packet: `${PACKETS_DIR}/a.py`, bytes: 40_000 },
    { branch: 'structural', id: 'i2', entrypoint: 'B#b', packet: `${PACKETS_DIR}/b.py`, bytes: 90_000 },
  ] }, null, 2)}\n`);

  const whole = branchWorkloads(root)[0];
  const kept = branchWorkloads(root, new Map([['structural', new Set(['i1'])]]))[0];

  assert.equal(whole.bytes, 130_000);
  assert.equal(kept.bytes, 40_000, 'the interface the plan dropped takes its reading with it');
});
