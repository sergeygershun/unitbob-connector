import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointPath, workerPlanDigest, workerPlanPath } from '../src/files/workerPlan.ts';
import { validateWorkerCheckpoints } from '../src/verbs/validateWorkerCheckpoints.ts';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'unitbob-checkpoints-'));
  mkdirSync(join(root, '.unitbob/suite-build'), { recursive: true });
  const requestBytes = '{"budget":{"workers":4},"branches":[{"suite_kind":"behavioral","assignment":{"capabilities":[{"capability_id":"c1"}]}}]}\n';
  writeFileSync(join(root, '.unitbob/suite-build/request.json'), requestBytes);
  const requestDigest = createHash('sha256').update(requestBytes).digest('hex');
  const plan = { request_digest: requestDigest, workers: [{
    branch: 'behavioral', worker_id: 'b1', capability_ids: ['c1'], promises: ['p1', 'p2'],
    planned_cases: ['s1', 's2'], source_paths: ['app/x.rb'],
    owned_paths: ['.unitbob/behavioral/features/b1.feature'],
    harness_path: '.unitbob/behavioral/step_definitions/00_unitbob_world.rb',
    limits: { planned_cases: 2, fact_finder_lookups: 8 }, done_when: 'done',
  }] };
  writeFileSync(workerPlanPath(root), `${JSON.stringify(plan, null, 2)}\n`);
  const checkpoint = {
    request_digest: requestDigest, plan_digest: workerPlanDigest(root), branch: 'behavioral', worker_id: 'b1',
    completed_promises: ['p1'], unresolved_promises: ['p2'],
    written_paths: ['.unitbob/behavioral/features/b1.feature'],
    facts: [{ fact: 'The route creates an order.', source_refs: ['app/x.rb:12'] }],
    decisions: ['Keep the refusal outcome separate.'],
    known_problems: [],
  };
  mkdirSync(join(root, '.unitbob/suite-build/checkpoints'), { recursive: true });
  writeFileSync(checkpointPath(root, plan.workers[0]), JSON.stringify(checkpoint));
  return root;
}

test('accepts a partial checkpoint whose unresolved promises can rotate to repair', async () => {
  const root = fixture();
  const result = await validateWorkerCheckpoints({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } });
  assert.deepEqual(result.valid_workers, ['behavioral:b1']);
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
