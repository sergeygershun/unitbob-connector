import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateWorkerPlan } from '../src/verbs/validateWorkerPlan.ts';
import { workerPlanPath, workerPlanDigest } from '../src/files/workerPlan.ts';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'unitbob-worker-plan-'));
  mkdirSync(join(root, '.unitbob', 'suite-build'), { recursive: true });
  const request = {
    project_root: root, output_path: join(root, '.unitbob/suite-build/suite_output.json'),
    budget: { workers: 4, review_rounds: 2, repair_rounds: 1 },
    branches: [
      { suite_kind: 'structural', assignment: { blocks: [{ block_id: 'billing', interfaces: [
        { interface_id: 'b1' }, { interface_id: 'b2' },
      ] }, { block_id: 'empty', interfaces: [] }] } },
      { suite_kind: 'behavioral', assignment: { capabilities: [{ capability_id: 'c1' }, { capability_id: 'c2' }] } },
    ],
  };
  const bytes = `${JSON.stringify(request, null, 2)}\n`;
  writeFileSync(join(root, '.unitbob/suite-build/request.json'), bytes);
  const requestDigest = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(workerPlanPath(root), `${JSON.stringify({ request_digest: requestDigest, workers: [
    item('structural', 's1', ['b1'], ['p1'], ['e1'], ['.unitbob/structural/s1_spec.rb']),
    item('structural', 's2', ['b2'], ['p2'], ['e2'], ['.unitbob/structural/s2_spec.rb']),
    item('behavioral', 'b1', ['c1'], ['p3'], ['scenario 1'], ['.unitbob/behavioral/features/b1.feature']),
    item('behavioral', 'b2', ['c2'], ['p4'], ['scenario 2'], ['.unitbob/behavioral/features/b2.feature']),
  ] }, null, 2)}\n`);
  return root;
}

function item(branch: string, workerId: string, capabilities: string[], promises: string[], plannedCases: string[], ownedPaths: string[]) {
  return {
    branch, worker_id: workerId, capability_ids: capabilities, promises, planned_cases: plannedCases,
    source_paths: ['app/example.rb'], owned_paths: ownedPaths,
    harness_path: branch === 'behavioral'
      ? '.unitbob/behavioral/step_definitions/00_unitbob_world.rb'
      : '.unitbob/structural/unitbob_helper.rb',
    limits: { planned_cases: plannedCases.length, fact_finder_lookups: 8 },
    done_when: 'All planned cases are written and checkpointed.',
  };
}

test('validates a complete non-empty balanced plan and returns its exact-byte digest', async () => {
  const root = project();
  const result = await validateWorkerPlan({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } });
  assert.equal(result.plan_digest, workerPlanDigest(root));
});

test('reports every plan problem in one batch', async () => {
  const root = project();
  const path = workerPlanPath(root);
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  plan.request_digest = 'stale';
  plan.workers[1].capability_ids = ['b1'];
  plan.workers[1].owned_paths = plan.workers[0].owned_paths;
  plan.workers[1].planned_cases = ['a', 'b', 'c'];
  plan.workers[1].limits.planned_cases = 3;
  writeFileSync(path, JSON.stringify(plan));

  await assert.rejects(
    validateWorkerPlan({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    (error: Error) => {
      assert.match(error.message, /request_digest/);
      assert.match(error.message, /b1.*more than once|more than once.*b1/i);
      assert.match(error.message, /b2.*missing|missing.*b2/i);
      assert.match(error.message, /owned path/i);
      assert.match(error.message, /1\.5/);
      return true;
    },
  );
});

test('rejects empty slices and more workers than the branch budget or capability count', async () => {
  const root = project();
  const path = workerPlanPath(root);
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  plan.workers.push(item('behavioral', 'b3', [], [], [], ['.unitbob/behavioral/features/b3.feature']));
  writeFileSync(path, JSON.stringify(plan));

  await assert.rejects(
    validateWorkerPlan({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    /non-empty|worker count/i,
  );
});

test('reports malformed worker items without throwing a raw TypeError', async () => {
  const root = project();
  const path = workerPlanPath(root);
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  plan.workers[0] = null;
  plan.workers[1].owned_paths = plan.workers[2].owned_paths;
  writeFileSync(path, JSON.stringify(plan));

  await assert.rejects(
    validateWorkerPlan({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    (error: Error) => {
      assert.match(error.message, /workers\[0\].*must be an object/);
      assert.match(error.message, /owned path/);
      assert.doesNotMatch(error.message, /TypeError/);
      return true;
    },
  );
});
