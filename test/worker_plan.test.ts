import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateWorkerPlan } from '../src/verbs/validateWorkerPlan.ts';
import { workerPlanPath, workerPlanDigest, validateWorkerPlanFiles } from '../src/files/workerPlan.ts';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'unitbob-worker-plan-'));
  mkdirSync(join(root, '.unitbob', 'suite-build'), { recursive: true });
  const request = {
    project_root: root, output_path: join(root, '.unitbob/suite-build/suite_output.json'),
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
    limits: { planned_cases: plannedCases.length },
    done_when: 'All planned cases are written and checkpointed.',
  };
}

test('validates a complete non-empty plan and returns its exact-byte digest', async () => {
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
      assert.match(error.message, /owned path/i);
      return true;
    },
  );
});

test('rejects empty slices', async () => {
  const root = project();
  const path = workerPlanPath(root);
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  plan.workers.push(item('behavioral', 'b3', [], [], [], ['.unitbob/behavioral/features/b3.feature']));
  writeFileSync(path, JSON.stringify(plan));

  await assert.rejects(
    validateWorkerPlan({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    /non-empty/i,
  );
});

// Spec 34-6, criteria 1.6 and 2.1. The plan is where the coordinator's scope
// choice is recorded, and there is nowhere else it is written down — so a plan
// that guards two of the assignment's capabilities is an ordinary plan, not a
// half-finished one. It is also allowed to be as wide as it likes, and as
// unevenly split: the ceilings on worker count and on slice ratio made the plan
// a copy of the assignment's shape rather than of the work's.
test('a plan that covers part of the assignment passes, at any width and any balance', async () => {
  const root = project();
  const path = workerPlanPath(root);
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  plan.workers = [
    item('structural', 's1', ['b1'], ['p1'], ['e1'], ['.unitbob/structural/s1_spec.rb']),
    item('behavioral', 'b1', ['c1'], ['p3'], ['1', '2', '3', '4', '5', '6'],
      ['.unitbob/behavioral/features/b1.feature']),
  ];
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);

  const result = await validateWorkerPlan(
    { server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } },
  );

  assert.equal(result.plan_digest, workerPlanDigest(root));
});

// The neighbours of the removed check catch a plan that is wrong rather than one
// that is narrow, and they stay.
test('a capability the request never assigned is still an error', async () => {
  const root = project();
  const path = workerPlanPath(root);
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  plan.workers[3].capability_ids = ['c9'];
  writeFileSync(path, JSON.stringify(plan));

  await assert.rejects(
    validateWorkerPlan({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    /c9 was not assigned by the request/i,
  );
});

test('a branch with an assignment and no slice at all is still an error', async () => {
  const root = project();
  const path = workerPlanPath(root);
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  plan.workers = plan.workers.filter((worker: { branch: string }) => worker.branch === 'structural');
  writeFileSync(path, JSON.stringify(plan));

  await assert.rejects(
    validateWorkerPlan({ server: '', repoId: 1, projectRoot: root }, [], { stdout: { write: () => true } }),
    /behavioral: no worker slice was planned/i,
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

// Both connector-owned harness files are Ruby, and only a Ruby project has
// them. Demanding them on every stack refused every Python and JS plan over a
// file that does not exist and would mean nothing if it did — the same mistake
// as the stack gate that reported a Python project as no stack at all. What is
// required of the other stacks is what the rule was ever about: the harness is
// connector territory, under `.unitbob/`. Found 2026-08-12.
test('the harness path a plan must name follows the project stack', () => {
  const root = project();
  const plan = JSON.parse(readFileSync(workerPlanPath(root), 'utf8'));

  // Python project: a Ruby World path is not required, and a path outside
  // .unitbob/ is still refused.
  writeFileSync(join(root, 'requirements.txt'), 'flask\n');
  for (const worker of plan.workers) {
    worker.harness_path = worker.branch === 'behavioral'
      ? '.unitbob/behavioral/step_definitions/conftest.py'
      : '.unitbob/pytest.ini';
  }
  writeFileSync(workerPlanPath(root), `${JSON.stringify(plan, null, 2)}\n`);
  assert.deepEqual(validateWorkerPlanFiles(root).filter((e) => e.includes('harness_path')), []);

  plan.workers[0].harness_path = 'spec/rails_helper.rb';
  writeFileSync(workerPlanPath(root), `${JSON.stringify(plan, null, 2)}\n`);
  assert.match(
    validateWorkerPlanFiles(root).find((e) => e.includes('harness_path')) ?? '',
    /connector-owned path under \.unitbob\//,
  );
});
