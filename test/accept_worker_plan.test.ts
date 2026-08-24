import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PACKETS_DIR, packetIndexPath, type PacketTarget } from '../src/files/packets.ts';
import { branchWorkloads } from '../src/files/fanOut.ts';
import { checkpointPath, workerPlanDigest, workerPlanPath } from '../src/files/workerPlan.ts';
import { acceptWorkerPlan } from '../src/verbs/acceptWorkerPlan.ts';
import { validateWorkerCheckpoints } from '../src/verbs/validateWorkerCheckpoints.ts';

// Spec 37-1, criterion 3. The size of a worker's packets is printed, never
// enforced — and printed by the machine that built them, so the coordinator
// neither counts bytes nor pairs entrypoints to workers by hand.

function project(packets?: PacketTarget[]): string {
  const root = mkdtempSync(join(tmpdir(), 'unitbob-accept-plan-'));
  mkdirSync(join(root, '.unitbob', 'suite-build'), { recursive: true });
  const request = {
    project_root: root,
    output_path: join(root, '.unitbob/suite-build/suite_output.json'),
    branches: [
      { suite_kind: 'structural', assignment: { blocks: [{ block_id: 'billing', interfaces: [
        { interface_id: 'b1' }, { interface_id: 'b2' },
      ] }] } },
    ],
  };
  const bytes = `${JSON.stringify(request, null, 2)}\n`;
  writeFileSync(join(root, '.unitbob/suite-build/request.json'), bytes);

  // The index goes down before the plan, because since spec 37-3 the plan has
  // to state the work it was divided from and that is measured from the packets.
  if (packets) {
    mkdirSync(join(root, PACKETS_DIR), { recursive: true });
    writeFileSync(packetIndexPath(root), `${JSON.stringify({ targets: packets }, null, 2)}\n`);
  }

  const workers = [
    item('s1', ['b1'], '.unitbob/structural/s1_spec.rb'),
    item('s2', ['b2'], '.unitbob/structural/s2_spec.rb'),
  ];
  const fan_out: Record<string, { work_tokens: number; workers: number }> = {};
  for (const load of branchWorkloads(root)) {
    const mine = workers.filter((worker) => worker.branch === load.branch).length;
    if (mine > 0) fan_out[load.branch] = { work_tokens: load.work_tokens, workers: mine };
  }

  writeFileSync(workerPlanPath(root), `${JSON.stringify({
    request_digest: createHash('sha256').update(bytes).digest('hex'),
    ...(Object.keys(fan_out).length > 0 ? { fan_out } : {}),
    workers,
  }, null, 2)}\n`);
  return root;
}

// Spec 37-3, criterion 1. These fixtures plan two slices, and two slices are now
// only legal for work that does not fit in one — so the packets below have to
// describe a project big enough to need two. Both halves stay under
// MAX_PACKET_BYTES (200,000), because a single packet larger than that cannot
// exist on disk: `copyPacket` refuses to write it. One file can therefore never
// justify a second worker, which is the rule working, not a fixture problem.
const BIG_HALF = 160_000;
const SMALL_HALF = 140_000;

function item(workerId: string, capabilityIds: string[], ownedPath: string) {
  return {
    branch: 'structural', worker_id: workerId, capability_ids: capabilityIds,
    promises: [`promise for ${workerId}`], planned_cases: ['case'],
    source_paths: ['app/example.rb'], owned_paths: [ownedPath],
    harness_path: '.unitbob/structural/unitbob_helper.rb',
    done_when: 'All planned cases are written and checkpointed.',
  };
}

async function run(root: string): Promise<string> {
  const written: string[] = [];
  await acceptWorkerPlan({ server: '', repoId: 1, projectRoot: root }, [], {
    stdout: { write: (chunk) => written.push(chunk) },
  });
  return written.join('');
}

function seed(root: string, workerId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(checkpointPath(root, { branch: 'structural', worker_id: workerId }), 'utf8'));
}

test('each worker is told which packets are its own and what they weigh', async () => {
  const root = project([
    { branch: 'structural', id: 'b1', entrypoint: 'User#pay', packet: `${PACKETS_DIR}/app/models.py`, bytes: BIG_HALF },
    { branch: 'structural', id: 'b1', entrypoint: 'User#refund', packet: `${PACKETS_DIR}/app/models.py`, bytes: BIG_HALF },
    { branch: 'structural', id: 'b2', entrypoint: 'Cart#add', packet: `${PACKETS_DIR}/app/cart.py`, bytes: SMALL_HALF },
  ]);

  const output = await run(root);

  // Two entrypoints in one file are one packet, counted once.
  assert.match(output, /structural:s1 — 1 packet, 160,000 bytes:/);
  assert.match(output, /structural:s2 — 1 packet, 140,000 bytes:/);
  assert.match(output, new RegExp(`${PACKETS_DIR}/app/models\\.py`));
  assert.match(output, new RegExp(`${PACKETS_DIR}/app/cart\\.py`));
});

test('a worker whose entrypoints did not resolve is told it reads the source itself', async () => {
  const root = project([
    { branch: 'structural', id: 'b1', entrypoint: 'User#pay', packet: `${PACKETS_DIR}/app/models.py`, bytes: BIG_HALF },
    { branch: 'structural', id: 'b1', entrypoint: 'User#save', packet: `${PACKETS_DIR}/app/store.py`, bytes: SMALL_HALF },
    { branch: 'structural', id: 'b2', entrypoint: 'Cart#add', note: 'no single file answers to this name' },
  ]);

  const output = await run(root);

  assert.match(output, /structural:s2 — no packets \(1 entrypoint did not resolve\), it reads the source itself\./);
});

test('a plan with no packet index says nothing about packets at all', async () => {
  const output = await run(project());

  assert.match(output, /^Worker plan valid \([0-9a-f]{64}\)\. Fan-out may start\.\n/);
  assert.doesNotMatch(output, /packet/);
});

test('an over-fuse entrypoint hands the worker the path instead of calling it unresolved', async () => {
  const root = project([
    { branch: 'structural', id: 'b1', entrypoint: 'Huge#create', source_file: 'app/huge.rb', bytes: 250_000 },
    { branch: 'structural', id: 'b2', entrypoint: 'Cart#add', packet: `${PACKETS_DIR}/app/cart.py`, bytes: SMALL_HALF },
  ]);

  const output = await run(root);

  assert.match(output, /structural:s1 — no packets \(1 too large to carry, open in place: app\/huge\.rb\)/);
  assert.doesNotMatch(output, /structural:s1[^\n]*did not resolve/);
});

test('two branches sharing one id do not receive each other packets', async () => {
  const root = project([
    { branch: 'structural', id: 'b1', entrypoint: 'User#pay', packet: `${PACKETS_DIR}/app/models.py`, bytes: BIG_HALF },
    { branch: 'structural', id: 'b1', entrypoint: 'User#save', packet: `${PACKETS_DIR}/app/store.py`, bytes: SMALL_HALF },
    { branch: 'behavioral', id: 'b1', entrypoint: 'POST /pay', packet: `${PACKETS_DIR}/app/web.py`, bytes: 99 },
  ]);

  const output = await run(root);

  assert.match(output, /structural:s1 — 2 packets, 300,000 bytes:/);
  assert.doesNotMatch(output, /app\/web\.py/);
});

test('an index with no targets prints no section at all', async () => {
  const output = await run(project([]));

  assert.match(output, /^Worker plan valid \([0-9a-f]{64}\)\. Fan-out may start\.\n/);
  assert.doesNotMatch(output, /packet/);
});

test('a hand-broken index costs the printout, not the gate', async () => {
  const root = project();
  mkdirSync(join(root, PACKETS_DIR), { recursive: true });
  writeFileSync(packetIndexPath(root), '{"targets":[null,{"no":"id"}]}\n');

  const output = await run(root);

  assert.match(output, /Worker plan valid/);
});

// Spec 37-2, criterion 1. The side that checks the form is the side that writes
// it, so a checkpoint refused for its shape stops being possible. On the a2time
// run of 2026-08-17 the coordinator wrote all eight by hand at peak context and
// still got them back rejected over a forgotten empty array.

test('a plan that passes is also seeded: one checkpoint per slice, and the gate takes them', async () => {
  const root = project();

  const output = await run(root);

  assert.match(output, /2 checkpoints seeded/);
  assert.deepEqual(seed(root, 's1'), {
    request_digest: JSON.parse(readFileSync(workerPlanPath(root), 'utf8')).request_digest,
    plan_digest: workerPlanDigest(root),
    branch: 'structural',
    worker_id: 's1',
    completed_promises: [],
    unresolved_promises: ['promise for s1'],
    written_paths: [],
    facts: [],
    decisions: [],
    known_problems: [],
  });

  // The gate of step 8, run against what the machine just wrote.
  await validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], {
    stdout: { write: () => true },
  });
});

test('a behavioral slice is seeded with the array only its branch owes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unitbob-accept-plan-'));
  mkdirSync(join(root, '.unitbob', 'suite-build'), { recursive: true });
  const request = {
    project_root: root,
    output_path: join(root, '.unitbob/suite-build/suite_output.json'),
    branches: [
      { suite_kind: 'structural', assignment: { blocks: [{ block_id: 'billing', interfaces: [{ interface_id: 'b1' }] }] } },
      { suite_kind: 'behavioral', assignment: { capabilities: [{ capability_id: 'checkout' }] } },
    ],
  };
  const bytes = `${JSON.stringify(request, null, 2)}\n`;
  writeFileSync(join(root, '.unitbob/suite-build/request.json'), bytes);
  writeFileSync(workerPlanPath(root), `${JSON.stringify({
    request_digest: createHash('sha256').update(bytes).digest('hex'),
    workers: [
      item('s1', ['b1'], '.unitbob/structural/s1_spec.rb'),
      {
        ...item('b1', ['checkout'], '.unitbob/behavioral/features/checkout.feature'),
        branch: 'behavioral',
        harness_path: '.unitbob/behavioral/step_definitions/00_unitbob_world.rb',
      },
    ],
  }, null, 2)}\n`);

  await run(root);

  const behavioral = JSON.parse(
    readFileSync(checkpointPath(root, { branch: 'behavioral', worker_id: 'b1' }), 'utf8'),
  );
  assert.deepEqual(behavioral.surface_coverage, []);
  assert.ok(!('surface_coverage' in seed(root, 's1')), 'a structural slice has no Scenarios to join');
});

// The run costs hours. A second `accept-worker-plan` over a plan that has not
// changed must not overwrite the facts the coordinator added to the seeds, or
// the work a worker has already checkpointed into them.
test('a checkpoint that belongs to this plan is left exactly as it is', async () => {
  const root = project();
  await run(root);
  const filled = { ...seed(root, 's1'), completed_promises: ['promise for s1'], unresolved_promises: [] };
  writeFileSync(checkpointPath(root, { branch: 'structural', worker_id: 's1' }), `${JSON.stringify(filled, null, 2)}\n`);

  const output = await run(root);

  assert.deepEqual(seed(root, 's1').completed_promises, ['promise for s1']);
  assert.match(output, /2 left in place/);
  assert.match(output, /No checkpoint needed seeding/);
});

// The opposite case, and the reason the rule is the plan digest rather than
// "does the file exist": a checkpoint written against a plan that no longer
// exists is refused by the gate, and leaving it would hand the coordinator back
// the very cleanup this criterion takes away.
//
// But it is never overwritten. `plan_digest` covers the whole plan file, so
// editing one slice — replanning after the first one comes back, which the
// workflow calls legitimate — invalidates every checkpoint at once, finished
// ones included. Overwriting in place would make this verb the one thing in the
// build that destroys hours of work, on its most ordinary path.
test('a checkpoint left over from another plan is moved aside, never overwritten', async () => {
  const root = project();
  await run(root);
  const stale = {
    ...seed(root, 's1'),
    plan_digest: 'a'.repeat(64),
    completed_promises: ['promise for s1'],
    unresolved_promises: [],
    decisions: ['worth keeping'],
  };
  writeFileSync(checkpointPath(root, { branch: 'structural', worker_id: 's1' }), `${JSON.stringify(stale, null, 2)}\n`);

  const output = await run(root);

  assert.equal(seed(root, 's1').plan_digest, workerPlanDigest(root));
  assert.deepEqual(seed(root, 's1').decisions, []);
  const aside = JSON.parse(readFileSync(
    join(root, '.unitbob', 'suite-build', 'checkpoints', 'superseded', 'structural-s1.json'),
    'utf8',
  ));
  assert.deepEqual(aside.decisions, ['worth keeping']);
  assert.deepEqual(aside.completed_promises, ['promise for s1']);
  assert.match(output, /Nothing was overwritten: structural:s1 moved to/);
});

// Twice over, because the second replan must not destroy what the first one
// saved from a checkpoint of the same name.
test('the superseded copy of a slice is itself replaced, not stacked or lost', async () => {
  const root = project();
  await run(root);
  const path = checkpointPath(root, { branch: 'structural', worker_id: 's1' });
  writeFileSync(path, `${JSON.stringify({ ...seed(root, 's1'), plan_digest: 'a'.repeat(64), decisions: ['first'] }, null, 2)}\n`);
  await run(root);
  writeFileSync(path, `${JSON.stringify({ ...seed(root, 's1'), plan_digest: 'b'.repeat(64), decisions: ['second'] }, null, 2)}\n`);

  await run(root);

  const aside = JSON.parse(readFileSync(
    join(root, '.unitbob', 'suite-build', 'checkpoints', 'superseded', 'structural-s1.json'),
    'utf8',
  ));
  assert.deepEqual(aside.decisions, ['second']);
});

// The pair that names the file is checked before anything is written with it.
// `worker_id` always was; `branch` never was, because until this spec it was
// only ever read.
test('a branch name that is a path refuses the plan instead of writing outside it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unitbob-accept-plan-'));
  mkdirSync(join(root, '.unitbob', 'suite-build'), { recursive: true });
  const request = {
    project_root: root,
    branches: [{ suite_kind: '../../../escaped', assignment: { blocks: [{ block_id: 'b', interfaces: [{ interface_id: 'b1' }] }] } }],
  };
  const bytes = `${JSON.stringify(request, null, 2)}\n`;
  writeFileSync(join(root, '.unitbob/suite-build/request.json'), bytes);
  writeFileSync(workerPlanPath(root), `${JSON.stringify({
    request_digest: createHash('sha256').update(bytes).digest('hex'),
    workers: [{ ...item('s1', ['b1'], '.unitbob/../../../escaped/s1.rb'), branch: '../../../escaped' }],
  }, null, 2)}\n`);

  await assert.rejects(() => run(root), /branch must be a filename-safe name/);
  assert.ok(!existsSync(join(root, '..', '..', '..', 'escaped-s1.json')));
});

test('an invalid plan seeds nothing', async () => {
  const root = project();
  const plan = JSON.parse(readFileSync(workerPlanPath(root), 'utf8'));
  plan.request_digest = 'nope';
  writeFileSync(workerPlanPath(root), `${JSON.stringify(plan, null, 2)}\n`);

  await assert.rejects(() => run(root), /Worker plan is invalid/);
  assert.ok(!existsSync(checkpointPath(root, { branch: 'structural', worker_id: 's1' })));
});
