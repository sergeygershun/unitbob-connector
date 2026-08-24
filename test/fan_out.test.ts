import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { branchWorkloads, workersFor, WORK_PER_WORKER_TOKENS } from '../src/files/fanOut.ts';
import { readWorkerPlan, takenIds, validateWorkerPlanFiles, workerPlanPath } from '../src/files/workerPlan.ts';
import { MAX_PACKET_BYTES, PACKETS_DIR, packetIndexPath, type PacketTarget } from '../src/files/packets.ts';

// Spec 37-3, criterion 1. The width of a branch's fan-out is decided by how much
// work there is, not by how many entries the map happens to list. On microblog,
// 2026-08-24, both branches' work fitted one worker each and fifteen workers ran
// — carrying 39,652 tokens of work between them, on 26,065 tokens of opening
// context apiece.

// Work is read plus the writing it implies, so a branch clears the ceiling a
// little above WORK_PER_WORKER_TOKENS bytes of source. No single packet can be
// that big — `copyPacket` refuses anything over MAX_PACKET_BYTES — so a second
// worker always takes at least two files, and these sizes say so out loud.
const HALF = Math.ceil((WORK_PER_WORKER_TOKENS + 4) / 2);
const ONE_WORKER = 40_000;

interface Fixture {
  // One entry per distinct source file, in bytes.
  files?: number[];
  // Entrypoints nothing resolved to a file.
  unresolved?: number;
  // A file found but too large to carry: a path and a size, no packet.
  overFuse?: number;
  slices?: number;
  // How many of the assignment's ids the plan actually takes. Defaults to all.
  takes?: number;
  fanOut?: unknown;
  bytesAs?: unknown;
}

function project(fixture: Fixture): string {
  const {
    files = [], unresolved = 0, overFuse, slices = 1, fanOut, bytesAs,
  } = fixture;
  const root = mkdtempSync(join(tmpdir(), 'unitbob-fan-out-'));
  mkdirSync(join(root, '.unitbob', 'suite-build'), { recursive: true });

  const assigned = Math.max(slices, fixture.takes ?? slices);
  const ids = Array.from({ length: assigned }, (_, index) => `i${index + 1}`);
  const request = {
    project_root: root,
    output_path: join(root, '.unitbob/suite-build/suite_output.json'),
    branches: [{
      suite_kind: 'structural',
      assignment: { blocks: [{ block_id: 'one', interfaces: ids.map((id) => ({ interface_id: id })) }] },
    }],
  };
  const requestBytes = `${JSON.stringify(request, null, 2)}\n`;
  writeFileSync(join(root, '.unitbob/suite-build/request.json'), requestBytes);

  // Everything hangs off the first id, so that narrowing the plan and counting
  // distinct files stay separable concerns in these fixtures.
  const targets: PacketTarget[] = [
    ...files.map((bytes, index) => ({
      branch: 'structural', id: ids[0], entrypoint: `Thing#f${index}`,
      // `in`, not `??`: null is one of the values under test here.
      packet: `${PACKETS_DIR}/app/f${index}.py`, bytes: ('bytesAs' in fixture ? bytesAs : bytes) as number,
    })),
    ...(overFuse === undefined ? [] : [{
      branch: 'structural', id: ids[0], entrypoint: 'Huge#create',
      source_file: 'app/huge.rb', bytes: overFuse,
      note: 'over the packet fuse',
    }]),
    ...Array.from({ length: unresolved }, (_, index) => ({
      branch: 'structural', id: ids[0], entrypoint: `Lost#g${index}`,
      note: 'no single file answers to this name',
    })),
  ];
  if (targets.length > 0) {
    mkdirSync(join(root, PACKETS_DIR), { recursive: true });
    writeFileSync(packetIndexPath(root), `${JSON.stringify({ targets }, null, 2)}\n`);
  }

  const workers = Array.from({ length: slices }, (_, index) => ({
    branch: 'structural', worker_id: `s${index + 1}`, capability_ids: [ids[index]],
    promises: [`promise ${index}`], planned_cases: ['case'],
    source_paths: ['app/thing.py'], owned_paths: [`.unitbob/structural/s${index + 1}_spec.rb`],
    harness_path: '.unitbob/structural/unitbob_helper.rb',
    done_when: 'All planned cases are written and checkpointed.',
  }));
  const plan: Record<string, unknown> = {
    request_digest: createHash('sha256').update(requestBytes).digest('hex'),
    workers,
  };
  writeFileSync(workerPlanPath(root), `${JSON.stringify(plan, null, 2)}\n`);

  // Written once the plan is on disk, and measured the way the gate measures —
  // over the ids the plan took — so the fixture cannot agree with the gate by
  // accident.
  if (fanOut !== null) {
    const measured = branchWorkloads(root, takenIds(readWorkerPlan(root)))[0];
    if (fanOut !== undefined) plan.fan_out = fanOut;
    else if (measured) plan.fan_out = { structural: { work_tokens: measured.work_tokens, workers: slices } };
    writeFileSync(workerPlanPath(root), `${JSON.stringify(plan, null, 2)}\n`);
  }
  return root;
}

const onlyError = (root: string): string => {
  const errors = validateWorkerPlanFiles(root);
  assert.equal(errors.length, 1, errors.join('\n') || 'expected exactly one error, got none');
  return errors[0];
};

test('work that fits one worker may not be split across two', () => {
  const error = onlyError(project({ files: [ONE_WORKER], slices: 2 }));

  assert.match(error, /2 slices for [\d,]+ tokens of work, which needs 1/);
  // The reason travels with the refusal: the coordinator has to know the second
  // slice costs a whole opening context and divides nothing.
  assert.match(error, /opening context/);
});

test('the same work in one worker passes', () => {
  assert.deepEqual(validateWorkerPlanFiles(project({ files: [ONE_WORKER], slices: 1 })), []);
});

test('work too large for one worker may be split', () => {
  assert.deepEqual(validateWorkerPlanFiles(project({ files: [HALF, HALF], slices: 2 })), []);
});

test('fewer workers than the work allows is never refused', () => {
  // A capability cannot be cut in half, so a branch may be narrower than its
  // work would permit. Only the ceiling is a rule.
  assert.deepEqual(validateWorkerPlanFiles(project({ files: [HALF, HALF], slices: 1 })), []);
});

test('a plan that does not say what it divided is refused, and told what to say', () => {
  const error = onlyError(project({ files: [ONE_WORKER], slices: 1, fanOut: null }));

  assert.match(error, /structural: fan_out is missing/);
  assert.match(error, /"work_tokens": \d+/);
  assert.match(error, /"workers": 1/);
});

test('a stated workload that disagrees with the packets on disk is refused', () => {
  const error = onlyError(project({
    files: [ONE_WORKER], slices: 1, fanOut: { structural: { work_tokens: 12, workers: 1 } },
  }));

  assert.match(error, /work_tokens is 12; the packets on disk measure [\d,]*\d/);
});

test('a stated width that disagrees with the slices actually planned is refused', () => {
  const error = onlyError(project({
    files: [ONE_WORKER], slices: 1, fanOut: { structural: { work_tokens: ONE_WORKER, workers: 4 } },
  }));

  assert.match(error, /workers says 4 but 1 slice was planned/);
});

// The same policy the packets themselves follow: a run whose checkout could not
// be read has no packets, and a rule with no measurement behind it must not
// refuse anybody's plan. Before spec 37-1 every run looked like this one.
test('a run without packets is measured by nothing and refused by nothing', () => {
  assert.deepEqual(validateWorkerPlanFiles(project({ slices: 4 })), []);
});

test('the workload counts a shared file once, not once per entrypoint', () => {
  const root = project({ files: [ONE_WORKER], slices: 1 });
  const load = branchWorkloads(root, takenIds(readWorkerPlan(root)))[0];

  assert.equal(load.files, 1);
  assert.equal(load.bytes, ONE_WORKER);
});

test('one worker is the floor, however little or strange the work', () => {
  assert.equal(workersFor(0), 1);
  assert.equal(workersFor(1), 1);
  assert.equal(workersFor(-5), 1);
  assert.equal(workersFor(Number.NaN), 1);
  assert.equal(workersFor(Number.POSITIVE_INFINITY), 1);
  assert.equal(workersFor(WORK_PER_WORKER_TOKENS), 1);
  assert.equal(workersFor(WORK_PER_WORKER_TOKENS + 1), 2);
});

// Found by review. Everything below is a way the measurement used to read as
// "no work", and every one of them made the ceiling *tighter* — so the branches
// carrying the heaviest, least-prepared work were the ones refused a second
// worker.

test('a file too large to carry is the heaviest work there is, not none of it', () => {
  const root = project({ files: [HALF], overFuse: HALF, slices: 2 });
  const load = branchWorkloads(root, takenIds(readWorkerPlan(root)))[0];

  assert.equal(load.files, 2, 'the over-fuse file is a file with a size, packet or no packet');
  assert.equal(load.bytes, HALF * 2);
  assert.deepEqual(validateWorkerPlanFiles(root), []);
});

test('the packet builder records the size of a file it refused to copy', () => {
  // The measurement above is only reachable because `writeSuitePackets` puts the
  // size on a target it could not carry. Pinned here so the two never drift.
  assert.ok(MAX_PACKET_BYTES > 0);
  const root = project({ overFuse: MAX_PACKET_BYTES + 1, slices: 1 });
  const load = branchWorkloads(root, takenIds(readWorkerPlan(root)))[0];

  assert.equal(load.files, 1);
  assert.equal(load.bytes, MAX_PACKET_BYTES + 1);
});

test('an entrypoint nothing resolved is priced at what the branch averages', () => {
  const root = project({ files: [ONE_WORKER, ONE_WORKER], unresolved: 2, slices: 1 });
  const load = branchWorkloads(root, takenIds(readWorkerPlan(root)))[0];

  assert.equal(load.unmeasured, 2);
  // Two measured files averaging ONE_WORKER, plus two unresolved at that same
  // average: four files' worth of work, not two.
  assert.equal(load.read_tokens, Math.round((ONE_WORKER * 4) / 4));
  assert.match(load.branch, /structural/);
});

test('a branch with nothing but unresolved entrypoints is measured by nothing', () => {
  const root = project({ unresolved: 3, slices: 3 });

  assert.deepEqual(branchWorkloads(root, takenIds(readWorkerPlan(root))), []);
  assert.deepEqual(validateWorkerPlanFiles(root), []);
});

test('a size that is not a byte count is a size we do not have, never a zero', () => {
  // A hand-edited index must not silently shrink the branch average and tighten
  // a ceiling nobody can see move. Strings, nulls and infinities all read as
  // "unmeasured", which prices them at the average instead.
  for (const bytesAs of ['40000', null, Number.POSITIVE_INFINITY, -1, {}]) {
    const root = project({ files: [ONE_WORKER, ONE_WORKER], slices: 1, bytesAs });
    const loads = branchWorkloads(root, takenIds(readWorkerPlan(root)));

    assert.deepEqual(loads, [], `bytes as ${JSON.stringify(bytesAs)} should measure nothing`);
    assert.deepEqual(validateWorkerPlanFiles(root), []);
  }
});

test('the gate weighs the work a plan took, never the whole assignment', () => {
  // Criterion 2 lets both branches be narrowed, and the packets are built from
  // the whole assignment before anybody chooses. Weighing all of them against a
  // narrowed plan's width would compare two different jobs.
  const root = project({ files: [HALF, HALF], slices: 1, takes: 3 });
  const all = branchWorkloads(root)[0];
  const mine = branchWorkloads(root, takenIds(readWorkerPlan(root)))[0];

  assert.equal(all.bytes, HALF * 2);
  assert.equal(mine.bytes, HALF * 2, 'this fixture hangs every file off the id the plan took');
  assert.deepEqual(validateWorkerPlanFiles(root), []);
});

test('work belonging to ids the plan did not take is not counted against it', () => {
  const root = mkdtempSync(join(tmpdir(), 'unitbob-fan-out-narrow-'));
  mkdirSync(join(root, '.unitbob', 'suite-build'), { recursive: true });
  const request = {
    project_root: root,
    output_path: join(root, '.unitbob/suite-build/suite_output.json'),
    branches: [{
      suite_kind: 'structural',
      assignment: { blocks: [{ block_id: 'one', interfaces: [{ interface_id: 'kept' }, { interface_id: 'dropped' }] }] },
    }],
  };
  const requestBytes = `${JSON.stringify(request, null, 2)}\n`;
  writeFileSync(join(root, '.unitbob/suite-build/request.json'), requestBytes);
  mkdirSync(join(root, PACKETS_DIR), { recursive: true });
  writeFileSync(packetIndexPath(root), `${JSON.stringify({ targets: [
    { branch: 'structural', id: 'kept', entrypoint: 'A#a', packet: `${PACKETS_DIR}/a.py`, bytes: ONE_WORKER },
    { branch: 'structural', id: 'dropped', entrypoint: 'B#b', packet: `${PACKETS_DIR}/b.py`, bytes: HALF },
  ] }, null, 2)}\n`);
  writeFileSync(workerPlanPath(root), `${JSON.stringify({
    request_digest: createHash('sha256').update(requestBytes).digest('hex'),
    workers: [{
      branch: 'structural', worker_id: 's1', capability_ids: ['kept'],
      promises: ['p'], planned_cases: ['case'], source_paths: ['a.py'],
      owned_paths: ['.unitbob/structural/s1_spec.rb'],
      harness_path: '.unitbob/structural/unitbob_helper.rb',
      done_when: 'All planned cases are written and checkpointed.',
    }],
  }, null, 2)}\n`);

  const whole = branchWorkloads(root)[0];
  const taken = branchWorkloads(root, takenIds(readWorkerPlan(root)))[0];

  assert.equal(whole.bytes, ONE_WORKER + HALF);
  assert.equal(taken.bytes, ONE_WORKER, 'the dropped interface takes its work with it');
});
