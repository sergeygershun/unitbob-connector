import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertUnitbobPath } from './artifactPath.ts';

export interface WorkerPlanItem {
  branch: string;
  worker_id: string;
  capability_ids: string[];
  promises: string[];
  planned_cases: unknown[];
  source_paths: string[];
  owned_paths: string[];
  harness_path: string;
  limits: { planned_cases: number };
  done_when: string;
}

export interface WorkerPlan {
  request_digest: string;
  workers: WorkerPlanItem[];
}

export function workerPlanPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'worker-plan.json');
}

function requestPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'request.json');
}

export function checkpointPath(
  projectRoot: string,
  item: Pick<WorkerPlanItem, 'branch' | 'worker_id'>,
): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'checkpoints', `${item.branch}-${item.worker_id}.json`);
}

export function exactFileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function requestDigest(projectRoot: string): string {
  return exactFileDigest(requestPath(projectRoot));
}

export function workerPlanDigest(projectRoot: string): string {
  return exactFileDigest(workerPlanPath(projectRoot));
}

export function readWorkerPlan(projectRoot: string): WorkerPlan {
  const path = workerPlanPath(projectRoot);
  if (!existsSync(path)) throw new Error(`${path} not found — write the complete worker plan before fan-out.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  return parsed as WorkerPlan;
}

export function validateWorkerPlanFiles(projectRoot: string): string[] {
  const errors: string[] = [];
  const plan = readWorkerPlan(projectRoot);
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(readFileSync(requestPath(projectRoot), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${requestPath(projectRoot)} is not valid JSON: ${(error as Error).message}`);
  }

  if (!plan || typeof plan !== 'object') return ['worker plan must be an object'];
  if (plan.request_digest !== requestDigest(projectRoot)) errors.push('request_digest does not match the exact request.json bytes');
  if (!Array.isArray(plan.workers) || plan.workers.length === 0) return [...errors, 'workers must be a non-empty array'];

  const branches = Array.isArray(request.branches) ? request.branches as Array<Record<string, unknown>> : [];
  const expectedByBranch = new Map(branches.map((branch) => [
    branch.suite_kind as string,
    assignmentIds(branch.assignment),
  ]));
  const seenWorkers = new Set<string>();
  const seenPaths = new Map<string, string>();

  for (const [index, item] of plan.workers.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`workers[${index}]: worker plan item must be an object`);
      continue;
    }
    const label = workerLabel(item, index);
    if (!isNonEmptyString(item?.branch) || !expectedByBranch.has(item.branch)) errors.push(`${label}: branch is not in the request`);
    if (!isNonEmptyString(item?.worker_id) || !/^[a-zA-Z0-9_-]+$/.test(item.worker_id)) errors.push(`${label}: worker_id must be a stable filename-safe id`);
    else if (seenWorkers.has(item.worker_id)) errors.push(`${label}: worker_id ${item.worker_id} appears more than once`);
    else seenWorkers.add(item.worker_id);

    for (const field of ['capability_ids', 'promises', 'planned_cases', 'source_paths', 'owned_paths'] as const) {
      if (!Array.isArray(item?.[field]) || item[field].length === 0) errors.push(`${label}: ${field} must be non-empty`);
    }
    for (const field of ['capability_ids', 'promises', 'source_paths', 'owned_paths'] as const) {
      if (Array.isArray(item?.[field]) && item[field].some((value) => !isNonEmptyString(value))) {
        errors.push(`${label}: ${field} must contain non-empty strings`);
      }
    }
    if (Array.isArray(item?.planned_cases) && item.planned_cases.some((value) =>
      !(isNonEmptyString(value) || (value !== null && typeof value === 'object')))) {
      errors.push(`${label}: planned_cases must contain non-empty intents`);
    }
    if (!isNonEmptyString(item?.done_when)) errors.push(`${label}: done_when must be non-empty`);
    if (!isNonEmptyString(item?.harness_path)) errors.push(`${label}: harness_path must be non-empty`);
    const expectedHarness = item?.branch === 'behavioral'
      ? '.unitbob/behavioral/step_definitions/00_unitbob_world.rb'
      : item?.branch === 'structural' ? '.unitbob/structural/unitbob_helper.rb' : null;
    if (expectedHarness && item.harness_path !== expectedHarness) {
      errors.push(`${label}: harness_path must name the connector-owned ${expectedHarness}`);
    }
    if (!item?.limits || item.limits.planned_cases !== item.planned_cases?.length) {
      errors.push(`${label}: limits.planned_cases must equal planned_cases.length`);
    }

    for (const ownedPath of Array.isArray(item?.owned_paths) ? item.owned_paths : []) {
      if (!isNonEmptyString(ownedPath)) {
        errors.push(`${label}: owned path must be a non-empty string`);
        continue;
      }
      try {
        assertUnitbobPath(ownedPath, `.unitbob/${item.branch}`);
      } catch (error) {
        errors.push(`${label}: ${(error as Error).message}`);
      }
      const owner = seenPaths.get(ownedPath);
      if (owner) errors.push(`${label}: owned path ${ownedPath} is also owned by ${owner}`);
      else seenPaths.set(ownedPath, label);
    }
  }

  // Spec 34-6, criterion 1.6. What is left here catches a corrupted plan, never
  // a small one. The gate used to also demand that every assigned capability
  // appear — which made the plan's size a copy of the assignment's size, and the
  // assignment is the whole product map. That is the load one worker could not
  // finish on a2time, 2026-08-10. Scope is chosen by the coordinator with the
  // user (workflow step 3), and the plan is the only record of it, so a plan
  // that covers part of the assignment is now an ordinary plan.
  //
  // The neighbours stay for the opposite reason: naming a capability the request
  // never assigned, or naming one twice, are ways a plan is wrong rather than
  // ways it is narrow. So is an empty plan for a branch that was given work.
  for (const [branch, expected] of expectedByBranch) {
    const items = plan.workers.filter((item) => item && typeof item === 'object' && !Array.isArray(item) && item.branch === branch);
    if (expected.length > 0 && items.length === 0) errors.push(`${branch}: no worker slice was planned`);
    const assigned = items.flatMap((item) => Array.isArray(item.capability_ids) ? item.capability_ids : []);
    for (const id of expected) {
      if (assigned.filter((candidate) => candidate === id).length > 1) {
        errors.push(`${branch}: assigned capability ${id} appears more than once`);
      }
    }
    for (const id of assigned.filter((id) => !expected.includes(id))) errors.push(`${branch}: capability ${id} was not assigned by the request`);
  }
  return errors;
}

function assignmentIds(value: unknown): string[] {
  const assignment = value as Record<string, unknown> | undefined;
  if (Array.isArray(assignment?.capabilities)) {
    return assignment.capabilities.flatMap((entry) => idFrom(entry, 'capability_id'));
  }
  if (!Array.isArray(assignment?.blocks)) return [];
  return assignment.blocks.flatMap((block) => {
    const record = block as Record<string, unknown>;
    return Array.isArray(record.interfaces)
      ? record.interfaces.flatMap((entry) => idFrom(entry, 'interface_id'))
      : [];
  });
}

function idFrom(value: unknown, field: string): string[] {
  const id = (value as Record<string, unknown> | undefined)?.[field];
  return isNonEmptyString(id) ? [id] : [];
}

function workerLabel(item: WorkerPlanItem | undefined, index: number): string {
  return item && isNonEmptyString(item.branch) && isNonEmptyString(item.worker_id)
    ? `${item.branch}:${item.worker_id}`
    : `workers[${index}]`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
