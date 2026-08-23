import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PACKETS_DIR, packetIndexPath, type PacketTarget } from '../src/files/packets.ts';
import { workerPlanPath } from '../src/files/workerPlan.ts';
import { validateWorkerPlan } from '../src/verbs/validateWorkerPlan.ts';

// Spec 37-1, criterion 3. The size of a worker's packets is printed, never
// enforced — and printed by the machine that built them, so the coordinator
// neither counts bytes nor pairs entrypoints to workers by hand.

function project(packets?: PacketTarget[]): string {
  const root = mkdtempSync(join(tmpdir(), 'unitbob-validate-plan-'));
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
  writeFileSync(workerPlanPath(root), `${JSON.stringify({
    request_digest: createHash('sha256').update(bytes).digest('hex'),
    workers: [
      item('s1', ['b1'], '.unitbob/structural/s1_spec.rb'),
      item('s2', ['b2'], '.unitbob/structural/s2_spec.rb'),
    ],
  }, null, 2)}\n`);

  if (packets) {
    mkdirSync(join(root, PACKETS_DIR), { recursive: true });
    writeFileSync(packetIndexPath(root), `${JSON.stringify({ targets: packets }, null, 2)}\n`);
  }
  return root;
}

function item(workerId: string, capabilityIds: string[], ownedPath: string) {
  return {
    branch: 'structural', worker_id: workerId, capability_ids: capabilityIds,
    promises: [`promise for ${workerId}`], planned_cases: ['case'],
    source_paths: ['app/example.rb'], owned_paths: [ownedPath],
    harness_path: '.unitbob/structural/unitbob_helper.rb',
    limits: { planned_cases: 1 },
    done_when: 'All planned cases are written and checkpointed.',
  };
}

async function run(root: string): Promise<string> {
  const written: string[] = [];
  await validateWorkerPlan({ server: '', repoId: 1, projectRoot: root }, [], {
    stdout: { write: (chunk) => written.push(chunk) },
  });
  return written.join('');
}

test('each worker is told which packets are its own and what they weigh', async () => {
  const root = project([
    { branch: 'structural', id: 'b1', entrypoint: 'User#pay', packet: `${PACKETS_DIR}/app/models.py`, bytes: 1200 },
    { branch: 'structural', id: 'b1', entrypoint: 'User#refund', packet: `${PACKETS_DIR}/app/models.py`, bytes: 1200 },
    { branch: 'structural', id: 'b2', entrypoint: 'Cart#add', packet: `${PACKETS_DIR}/app/cart.py`, bytes: 340 },
  ]);

  const output = await run(root);

  // Two entrypoints in one file are one packet, counted once.
  assert.match(output, /structural:s1 — 1 packet, 1,200 bytes:/);
  assert.match(output, /structural:s2 — 1 packet, 340 bytes:/);
  assert.match(output, new RegExp(`${PACKETS_DIR}/app/models\\.py`));
  assert.match(output, new RegExp(`${PACKETS_DIR}/app/cart\\.py`));
});

test('a worker whose entrypoints did not resolve is told it reads the source itself', async () => {
  const root = project([
    { branch: 'structural', id: 'b1', entrypoint: 'User#pay', packet: `${PACKETS_DIR}/app/models.py`, bytes: 1200 },
    { branch: 'structural', id: 'b2', entrypoint: 'Cart#add', note: 'no single file answers to this name' },
  ]);

  const output = await run(root);

  assert.match(output, /structural:s2 — no packets \(1 entrypoint did not resolve\), it reads the source itself\./);
});

test('a plan with no packet index prints exactly what it printed before this spec', async () => {
  const output = await run(project());

  assert.match(output, /^Worker plan valid \([0-9a-f]{64}\)\. Fan-out may start\.\n$/);
});

test('an over-fuse entrypoint hands the worker the path instead of calling it unresolved', async () => {
  const root = project([
    { branch: 'structural', id: 'b1', entrypoint: 'Huge#create', source_file: 'app/huge.rb' },
    { branch: 'structural', id: 'b2', entrypoint: 'Cart#add', packet: `${PACKETS_DIR}/app/cart.py`, bytes: 340 },
  ]);

  const output = await run(root);

  assert.match(output, /structural:s1 — no packets \(1 too large to carry, open in place: app\/huge\.rb\)/);
  assert.doesNotMatch(output, /structural:s1[^\n]*did not resolve/);
});

test('two branches sharing one id do not receive each other packets', async () => {
  const root = project([
    { branch: 'structural', id: 'b1', entrypoint: 'User#pay', packet: `${PACKETS_DIR}/app/models.py`, bytes: 1200 },
    { branch: 'behavioral', id: 'b1', entrypoint: 'POST /pay', packet: `${PACKETS_DIR}/app/web.py`, bytes: 99 },
  ]);

  const output = await run(root);

  assert.match(output, /structural:s1 — 1 packet, 1,200 bytes:/);
  assert.doesNotMatch(output, /app\/web\.py/);
});

test('an index with no targets prints no section at all', async () => {
  const output = await run(project([]));

  assert.match(output, /^Worker plan valid \([0-9a-f]{64}\)\. Fan-out may start\.\n$/);
});

test('a hand-broken index costs the printout, not the gate', async () => {
  const root = project();
  mkdirSync(join(root, PACKETS_DIR), { recursive: true });
  writeFileSync(packetIndexPath(root), '{"targets":[null,{"no":"id"}]}\n');

  const output = await run(root);

  assert.match(output, /Worker plan valid/);
});
