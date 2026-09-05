import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectStructuralRunner } from '../runner/precheck.ts';
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

// The addresses the request handed to each capability, indexed by id. Spec 41
// needs them in two places — the checkpoint gate, to refuse an address the slice
// was never given, and the upload, to work out what was left over — and both read
// them from the one file that carries them.
//
// A capability whose assignment lists no surfaces is absent from the map rather
// than present with an empty list: "this assignment does not say" and "this
// capability has no addresses" are different, and only the first must leave
// membership unchecked.
export function assignedSurfaces(projectRoot: string): Map<string, string[]> {
  const path = requestPath(projectRoot);
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const byId = new Map<string, string[]>();
  for (const branch of Array.isArray(request.branches) ? request.branches as Array<Record<string, unknown>> : []) {
    const assignment = branch.assignment as Record<string, unknown> | undefined;
    for (const entry of Array.isArray(assignment?.capabilities) ? assignment.capabilities as unknown[] : []) {
      const capability = entry as Record<string, unknown> | null;
      const id = capability?.capability_id;
      const surfaces = capability?.surfaces;
      if (!isNonEmptyString(id) || !Array.isArray(surfaces) || surfaces.length === 0) continue;
      byId.set(id, surfaces.filter(isNonEmptyString));
    }
  }
  return byId;
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

// Spec 37-2, criterion 1. Everything in a seeded checkpoint is either copied
// from the plan item or computed from two files on this disk, so writing it by
// hand was eight identical documents' worth of the most expensive turns in the
// run — and the gate refused them for a forgotten empty array often enough that
// the workflow had to spell the shape out in prose. Written here, next to the
// path and the digests it needs, and by the same side that checks it.
//
// The one thing the machine cannot supply is what the coordinator established
// about this project. `facts` is seeded empty for it to add to.
export interface SeededCheckpoints {
  written: string[];
  kept: string[];
  superseded: string[];
}

export const SUPERSEDED_DIR = 'superseded';

export function seedWorkerCheckpoints(projectRoot: string): SeededCheckpoints {
  const plan = readWorkerPlan(projectRoot);
  const request_digest = requestDigest(projectRoot);
  const plan_digest = workerPlanDigest(projectRoot);
  const written: string[] = [];
  const kept: string[] = [];
  const superseded: string[] = [];

  for (const item of plan.workers) {
    const path = checkpointPath(projectRoot, item);
    const label = `${item.branch}:${item.worker_id}`;
    // Left alone when it already belongs to this plan: the coordinator's facts
    // and a worker's finished slice both live in this file, and a run costs
    // hours.
    if (belongsToPlan(path, plan_digest)) {
      kept.push(label);
      continue;
    }

    // Everything else needs a fresh seed — but the file being replaced is not
    // necessarily worthless. `plan_digest` is a digest of the whole
    // `worker-plan.json`, so editing one slice invalidates every checkpoint at
    // once, including finished ones; and replanning after the first slice comes
    // back is a documented, ordinary move. Overwriting in place would have made
    // this verb the one thing in the build that destroys hours of work, on the
    // most ordinary path there is. Moved for the same reason `suite-prepare`
    // moves the previous run rather than deleting it.
    if (existsSync(path)) {
      const aside = join(dirname(path), SUPERSEDED_DIR, `${item.branch}-${item.worker_id}.json`);
      mkdirSync(dirname(aside), { recursive: true });
      rmSync(aside, { force: true });
      renameSync(path, aside);
      superseded.push(label);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(seedFor(item, request_digest, plan_digest), null, 2)}\n`);
    written.push(label);
  }
  return { written, kept, superseded };
}

function belongsToPlan(path: string, planDigest: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    return parsed?.plan_digest === planDigest;
  } catch {
    return false;
  }
}

function seedFor(item: WorkerPlanItem, request_digest: string, plan_digest: string): Record<string, unknown> {
  return {
    request_digest,
    plan_digest,
    branch: item.branch,
    worker_id: item.worker_id,
    // Every promise starts unresolved: the slice has not been worked yet, and
    // the gate wants each one accounted for exactly once.
    unresolved_promises: [...item.promises],
    completed_promises: [],
    written_paths: [],
    decisions: [],
    known_problems: [],
    // Behavioral only, and absent rather than empty elsewhere — they are about
    // addresses, and the structural branch has none.
    //
    // `unreachable_surfaces` is seeded empty because empty is the honest common
    // answer and the gate wants the key present either way. Its peer bucket,
    // `deferred_surfaces`, is deliberately not here: what a slice did not take is
    // the remainder of what it did, and it is worked out where the upload is
    // assembled. Two places to answer one question is how the two drift.
    ...(item.branch === 'behavioral' ? { surface_coverage: [], unreachable_surfaces: [] } : {}),
    facts: [],
  };
}

const RUBY_HARNESS: Record<string, string> = {
  behavioral: '.unitbob/behavioral/step_definitions/00_unitbob_world.rb',
  structural: '.unitbob/structural/unitbob_helper.rb',
};

export function validateWorkerPlanFiles(projectRoot: string): string[] {
  const errors: string[] = [];
  const rubyProject = detectStructuralRunner(projectRoot) === 'rspec';
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
    // Both halves of the checkpoint filename, held to the same rule. `worker_id`
    // has always been checked; `branch` never was, because it only ever came
    // from `request.json` and was only ever read. Since spec 37-2 the pair is
    // also a path this connector *writes*, and `request.json` is a file on the
    // vibecoder's disk — so a `suite_kind` of `../../..` would have put a
    // seeded checkpoint outside the project.
    else if (!/^[a-zA-Z0-9_-]+$/.test(item.branch)) errors.push(`${label}: branch must be a filename-safe name`);
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
    // Both connector-owned harness files are Ruby, and only a Ruby project has
    // them: `unitbob_helper.rb` boots Rails for RSpec, and the behavioral World
    // is materialized for cucumber alone. Demanding them everywhere refused
    // every Python and JS plan over a file that does not exist and would mean
    // nothing if it did — the same mistake as the stack gate that reported a
    // Python project as no stack at all. Found 2026-08-12.
    //
    // What is required of the other stacks is what the rule was ever about: the
    // harness is connector territory, under `.unitbob/`, not a file in the
    // project.
    const expectedHarness = rubyProject ? RUBY_HARNESS[item?.branch as string] ?? null : null;
    if (expectedHarness && item.harness_path !== expectedHarness) {
      errors.push(`${label}: harness_path must name the connector-owned ${expectedHarness}`);
    }
    if (!expectedHarness && isNonEmptyString(item?.harness_path) && !item.harness_path.startsWith('.unitbob/')) {
      errors.push(`${label}: harness_path must be a connector-owned path under .unitbob/ (got "${item.harness_path}")`);
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
  // Measured over the ids this plan actually took, never over the whole
  // assignment. The packets are built before anybody chooses a scope, and since
  // spec 37-3 criterion 2 both branches may be narrowed — so weighing the whole
  // assignment against the width of a narrowed plan would compare two different
  // jobs and refuse the narrow one for being narrow.
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
