import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkpointPath, workerPlanDigest, workerPlanPath } from '../src/files/workerPlan.ts';
import { validateWorkerCheckpoints } from '../src/verbs/validateWorkerCheckpoints.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function documentedFactExamples(): unknown[] {
  const agentPaths = [
    'plugin/agents/suite-worker.md',
    'plugin/agents/suite-repair-worker.md',
    'plugin/codex/agents/suite-worker.toml',
    'plugin/codex/agents/suite-repair-worker.toml',
  ];
  return agentPaths.map((agentPath) => {
    const instructions = readFileSync(join(packageRoot, agentPath), 'utf8');
    // By content, not by position: these files carry more than one one-line JSON
    // example now, and "the first block" would quietly start reading a different
    // schema the day someone puts another one above it.
    const match = [...instructions.matchAll(/```json\n(\{[^\n]+\})\n```/g)]
      .find((candidate) => candidate[1].includes('"fact"'));
    assert.ok(match, `${agentPath} must carry a machine-readable facts entry example`);
    return JSON.parse(match[1]);
  });
}

const READ_FACT = { fact: 'The route creates an order.', source_refs: ['app/x.rb:12'], established_by: 'read' };
const SCENARIO_JOIN = [{ capability_id: 'c1', scenario: 'A partner cancels an invoice', surfaces: ['POST /bills/:id/cancel'] }];
const ASSIGNED_SURFACES = ['POST /bills/:id/cancel', 'GET /oauth2callback', 'GET /bills/new'];
const UNREACHABLE = [{
  surface: 'GET /oauth2callback',
  reason: 'The payment provider sends the payer back to this address, and nothing we control can cause that request.',
}];

interface FixtureOptions {
  facts?: unknown[];
  branch?: 'behavioral' | 'structural';
  surfaceCoverage?: unknown;
  unreachableSurfaces?: unknown;
  assignedSurfaces?: string[];
}

function fixture(options: FixtureOptions = {}): string {
  const { facts = [READ_FACT], branch = 'behavioral', assignedSurfaces = ASSIGNED_SURFACES } = options;
  const root = mkdtempSync(join(tmpdir(), 'unitbob-checkpoints-'));
  mkdirSync(join(root, '.unitbob/suite-build'), { recursive: true });
  const assignment = JSON.stringify({ capabilities: [{ capability_id: 'c1', surfaces: assignedSurfaces }] });
  const requestBytes = `{"budget":{"workers":4},"branches":[{"suite_kind":"${branch}","assignment":${assignment}}]}\n`;
  writeFileSync(join(root, '.unitbob/suite-build/request.json'), requestBytes);
  const requestDigest = createHash('sha256').update(requestBytes).digest('hex');
  const ownedPath = branch === 'behavioral'
    ? '.unitbob/behavioral/features/b1.feature'
    : '.unitbob/structural/b1_spec.rb';
  const plan = { request_digest: requestDigest, workers: [{
    branch, worker_id: 'b1', capability_ids: ['c1'], promises: ['p1', 'p2'],
    planned_cases: ['s1', 's2'], source_paths: ['app/x.rb'],
    owned_paths: [ownedPath],
    harness_path: branch === 'behavioral'
      ? '.unitbob/behavioral/step_definitions/00_unitbob_world.rb'
      : '.unitbob/structural/unitbob_helper.rb',
    done_when: 'done',
  }] };
  writeFileSync(workerPlanPath(root), `${JSON.stringify(plan, null, 2)}\n`);
  const checkpoint: Record<string, unknown> = {
    request_digest: requestDigest, plan_digest: workerPlanDigest(root), branch, worker_id: 'b1',
    completed_promises: ['p1'], unresolved_promises: ['p2'],
    written_paths: [ownedPath],
    facts,
    decisions: ['Keep the refusal outcome separate.'],
    known_problems: [],
  };
  if ('surfaceCoverage' in options) checkpoint.surface_coverage = options.surfaceCoverage;
  else if (branch === 'behavioral') checkpoint.surface_coverage = SCENARIO_JOIN;
  if ('unreachableSurfaces' in options) checkpoint.unreachable_surfaces = options.unreachableSurfaces;
  else if (branch === 'behavioral') checkpoint.unreachable_surfaces = [];
  mkdirSync(join(root, '.unitbob/suite-build/checkpoints'), { recursive: true });
  writeFileSync(checkpointPath(root, plan.workers[0]), JSON.stringify(checkpoint));
  return root;
}

test('accepts a partial checkpoint whose unresolved promises can rotate to repair', async () => {
  const root = fixture();
  const result = await validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } });
  assert.deepEqual(result.valid_workers, ['behavioral:b1']);
});

test('accepts every facts entry documented for suite agents', async () => {
  for (const fact of documentedFactExamples()) {
    const root = fixture({ facts: [fact] });
    const result = await validateWorkerCheckpoints(
      { server: '', repoId: 1, projectRoot: root },
      [],
      { stdout: { write: () => true } },
    );
    assert.deepEqual(result.valid_workers, ['behavioral:b1']);
  }
});

test('reports string facts as checkpoint schema errors instead of leaking a TypeError', async () => {
  const root = fixture({ facts: [
    'The route creates an order (app/x.rb:12).',
    'The order redirects to its receipt (app/x.rb:20).',
  ] });

  await assert.rejects(
    validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    (error: Error) => {
      assert.match(error.message, /Worker checkpoints are invalid/);
      assert.match(error.message, /\$\.facts\[0\].*object.*fact.*source_refs.*got string/i);
      assert.match(error.message, /\$\.facts\[1\].*object.*fact.*source_refs.*got string/i);
      assert.doesNotMatch(error.message, /Cannot use 'in' operator/);
      return true;
    },
  );
});

test('batches a malformed checkpoint with other checkpoint schema errors', async () => {
  const root = fixture();
  const path = checkpointPath(root, { branch: 'behavioral', worker_id: 'b1' });
  writeFileSync(path, 'null');

  await assert.rejects(
    validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    /behavioral:b1: checkpoint must be an object/,
  );
});

// a2time, 2026-08-17. `surface_coverage` — which addresses each Scenario really
// drives — is required of the published metadata by the server, and the only
// place it existed was the coordinator's head: the checkpoint carried nothing
// about Scenarios at all. The coordinator assembled it from the workers' closing
// prose, the independent reviewer read the step files instead and found six
// Scenarios whose claimed addresses were not the ones the steps drove, and the
// server refused the publication. The worker is the one that knows; now it says.
test('requires a behavioral checkpoint to carry the scenario-to-surface join', async () => {
  const root = fixture({ surfaceCoverage: undefined });

  await assert.rejects(
    validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    /behavioral:b1: surface_coverage must be an array/,
  );
});

test('refuses coverage entries for a foreign capability, an unnamed scenario, or no surface', async () => {
  const root = fixture({ surfaceCoverage: [
    { capability_id: 'not-mine', scenario: 'A partner cancels an invoice', surfaces: ['POST /bills/:id/cancel'] },
    { capability_id: 'c1', scenario: '', surfaces: ['POST /bills/:id/cancel'] },
    { capability_id: 'c1', scenario: 'A partner restores an invoice', surfaces: [] },
  ] });

  await assert.rejects(
    validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    (error: Error) => {
      assert.match(error.message, /surface_coverage\[0\]\.capability_id not-mine is not in this plan item/);
      assert.match(error.message, /surface_coverage\[1\]\.scenario must name the exact Scenario/);
      assert.match(error.message, /surface_coverage\[2\]\.surfaces must name at least one surface/);
      return true;
    },
  );
});

// The join belongs to Gherkin Scenarios, and the structural branch has none.
// Demanding it there would refuse every structural slice over a key that would
// mean nothing if it were there — the mistake the harness rule already made once.
test('does not ask a structural slice for a behavioral join', async () => {
  const root = fixture({ branch: 'structural' });

  const result = await validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } });

  assert.deepEqual(result.valid_workers, ['structural:b1']);
});

// Spec 41, criterion 1. An address nothing can drive was knowable only to the
// worker that tried, and it had nowhere to write it: the checkpoint carried what
// was driven and nothing else, so unreachability travelled to the coordinator as
// closing prose — the exact arrangement spec 37-2 threw out for `surface_coverage`.
// It rides with the work that produced it now.
test('accepts a slice that declares an address nothing can drive', async () => {
  const root = fixture({ unreachableSurfaces: UNREACHABLE });

  const result = await validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } });

  assert.deepEqual(result.valid_workers, ['behavioral:b1']);
});

test('requires a behavioral checkpoint to carry the unreachable bucket at all', async () => {
  const root = fixture({ unreachableSurfaces: undefined });

  await assert.rejects(
    validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    /behavioral:b1: unreachable_surfaces must be an array/,
  );
});

// A reason per address, never one reason for a list — the rule the server states
// and the one thing that keeps this from becoming the door every inconvenient
// address goes through. A sentence you cannot write about *this* address is the
// signal it is not really unreachable.
test('refuses an unreachable address with no reason of its own', async () => {
  const root = fixture({ unreachableSurfaces: [{ surface: 'GET /oauth2callback', reason: '  ' }] });

  await assert.rejects(
    validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    /unreachable_surfaces\[0\]\.reason must say what has to happen elsewhere/,
  );
});

// The two answers the machine cannot compute for the slice. Everything else it
// works out itself: what is left over after driven and unreachable is deferred,
// and that arithmetic happens where the upload is assembled.
test('refuses an address that is both driven and unreachable, and one outside the assignment', async () => {
  const root = fixture({ unreachableSurfaces: [
    { surface: 'POST /bills/:id/cancel', reason: 'Only the provider can send this.' },
    { surface: 'GET /invented', reason: 'Nothing reaches it.' },
  ] });

  await assert.rejects(
    validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    (error: Error) => {
      assert.match(error.message, /POST \/bills\/:id\/cancel is driven by a Scenario and declared unreachable/);
      assert.match(error.message, /GET \/invented was not assigned to this slice/);
      return true;
    },
  );
});

test('refuses the same unreachable address named twice', async () => {
  const root = fixture({ unreachableSurfaces: [...UNREACHABLE, ...UNREACHABLE] });

  await assert.rejects(
    validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    /unreachable_surfaces names GET \/oauth2callback more than once/,
  );
});

// An assignment that lists no addresses for a capability cannot say whether one
// belongs to it. Refusing there would refuse honest slices over an absence.
test('does not check membership when the assignment lists no surfaces', async () => {
  const root = fixture({
    assignedSurfaces: [],
    unreachableSurfaces: [{ surface: 'GET /whatever', reason: 'Only a vendor can call it.' }],
  });

  const result = await validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } });

  assert.deepEqual(result.valid_workers, ['behavioral:b1']);
});

// a2time, 2026-08-17, again: a seeded fact said a dismissed employee cannot sign
// in. It was read from memory — one method confused with another — and reached
// sixteen workers marked as verified. Facts established by running the thing held
// all run; the one that was not, did not. So an entry now says which it is.
test('refuses a fact that does not say how it was established', async () => {
  const root = fixture({ facts: [{ fact: 'A dismissed employee cannot sign in.', source_refs: ['app/models/user.rb:31'] }] });

  await assert.rejects(
    validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    /facts\[0\]\.established_by must be "read" or "ran: <command>"/,
  );
});

test('refuses a provenance that names neither reading nor a command', async () => {
  const root = fixture({ facts: [
    { fact: 'A dismissed employee cannot sign in.', source_refs: [], established_by: 'verified' },
    { fact: 'The nightly job keeps drafts.', source_refs: [], established_by: 'ran: ' },
  ] });

  await assert.rejects(
    validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    (error: Error) => {
      assert.match(error.message, /facts\[0\]\.established_by must be "read" or "ran: <command>"/);
      assert.match(error.message, /facts\[1\]\.established_by must be "read" or "ran: <command>"/);
      return true;
    },
  );
});

test('accepts a fact established by running a command that names it', async () => {
  const root = fixture({ facts: [
    { fact: 'A dismissed employee still signs in (302).', source_refs: ['app/models/user.rb:31'], established_by: 'ran: curl -i -X POST /users/sign_in' },
  ] });

  const result = await validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } });

  assert.deepEqual(result.valid_workers, ['behavioral:b1']);
});

test('reports missing, stale and crossed checkpoint state by branch in one batch', async () => {
  const root = fixture();
  const path = checkpointPath(root, { branch: 'behavioral', worker_id: 'b1' });
  const checkpoint = JSON.parse(readFileSync(path, 'utf8'));
  checkpoint.request_digest = 'stale';
  checkpoint.plan_digest = 'stale-plan';
  checkpoint.worker_id = 'other';
  checkpoint.written_paths = ['.unitbob/behavioral/features/other.feature'];
  writeFileSync(path, JSON.stringify(checkpoint));

  await assert.rejects(
    validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    (error: Error) => {
      assert.match(error.message, /behavioral:b1/);
      assert.match(error.message, /request_digest/);
      assert.match(error.message, /plan_digest/);
      assert.match(error.message, /worker_id/);
      assert.match(error.message, /owned path/i);
      return true;
    },
  );
});
