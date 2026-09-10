import { existsSync, readFileSync } from 'node:fs';
import type { Config } from '../config.ts';
import {
  assignedSurfaces,
  checkpointPath,
  readWorkerPlan,
  requestDigest,
  validateWorkerPlanFiles,
  workerPlanDigest,
  type WorkerPlanItem,
} from '../files/workerPlan.ts';

export async function validateWorkerCheckpoints(
  config: Config,
  _args: string[] = [],
  deps: { stdout: { write: (chunk: string) => unknown } } = { stdout: process.stdout },
): Promise<{ valid_workers: string[] }> {
  const planErrors = validateWorkerPlanFiles(config.projectRoot);
  if (planErrors.length > 0) throw new Error(`Cannot validate checkpoints for an invalid worker plan:\n- ${planErrors.join('\n- ')}`);
  const plan = readWorkerPlan(config.projectRoot);
  const expectedRequestDigest = requestDigest(config.projectRoot);
  const expectedPlanDigest = workerPlanDigest(config.projectRoot);
  const assigned = assignedSurfaces(config.projectRoot);
  const errors: string[] = [];

  for (const item of plan.workers) {
    const label = `${item.branch}:${item.worker_id}`;
    const path = checkpointPath(config.projectRoot, item);
    if (!existsSync(path)) {
      errors.push(`${label}: checkpoint is missing at ${path}`);
      continue;
    }
    let checkpoint: Record<string, unknown>;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push(`${label}: checkpoint must be an object`);
        continue;
      }
      checkpoint = parsed as Record<string, unknown>;
    } catch (error) {
      errors.push(`${label}: checkpoint is not valid JSON: ${(error as Error).message}`);
      continue;
    }
    if (checkpoint.request_digest !== expectedRequestDigest) errors.push(`${label}: request_digest is stale`);
    if (checkpoint.plan_digest !== expectedPlanDigest) errors.push(`${label}: plan_digest is stale`);
    if (checkpoint.branch !== item.branch) errors.push(`${label}: branch does not match its plan item`);
    if (checkpoint.worker_id !== item.worker_id) errors.push(`${label}: worker_id does not match its plan item`);

    const completed = stringArray(checkpoint.completed_promises, `${label}: completed_promises`, errors);
    const unresolved = stringArray(checkpoint.unresolved_promises, `${label}: unresolved_promises`, errors);
    const accounted = [...completed, ...unresolved];
    for (const promise of item.promises) {
      const count = accounted.filter((candidate) => candidate === promise).length;
      if (count !== 1) errors.push(`${label}: promise ${promise} must appear exactly once across completed/unresolved promises`);
    }
    for (const promise of accounted.filter((candidate) => !item.promises.includes(candidate))) {
      errors.push(`${label}: checkpoint names promise ${promise} outside its plan item`);
    }
    const writtenPaths = stringArray(checkpoint.written_paths, `${label}: written_paths`, errors);
    for (const pathValue of writtenPaths.filter((candidate) => !item.owned_paths.includes(candidate))) {
      errors.push(`${label}: written path ${pathValue} is not an owned path`);
    }
    validateCompactFacts(checkpoint.facts, label, errors);
    validateSurfaceCoverage(checkpoint.surface_coverage, item, label, errors);
    validateUnreachableSurfaces(checkpoint.unreachable_surfaces, item, checkpoint.surface_coverage, assigned, label, errors);
    stringArray(checkpoint.decisions, `${label}: decisions`, errors);
    stringArray(checkpoint.known_problems, `${label}: known_problems`, errors);
  }

  if (errors.length > 0) throw new Error(`Worker checkpoints are invalid:\n- ${errors.join('\n- ')}`);
  const validWorkers = plan.workers.map((item) => `${item.branch}:${item.worker_id}`);
  deps.stdout.write(`Worker checkpoints valid for ${validWorkers.join(', ')}.\n`);
  return { valid_workers: validWorkers };
}

function stringArray(value: unknown, label: string, errors: string[]): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    errors.push(`${label} must be an array of non-empty strings`);
    return [];
  }
  return value;
}

// A fact says how it was established, and the vocabulary is two words wide:
// `read` when the `source_refs` are what establishes it, `ran: <command>` when
// something was executed and its result observed.
//
// a2time, 2026-08-17. A seeded fact claimed a dismissed employee cannot sign in.
// It came from reading one method and remembering another, it reached sixteen
// workers marked as verified, and it was false. Every fact that run established
// by running the application held; the one that was not, did not — and nothing in
// the checkpoint told the two apart, so no reader could weigh them differently.
const ESTABLISHED_BY = /^(read|ran: \S.*)$/;

function validateCompactFacts(value: unknown, label: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${label}: facts must be an array`);
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label}: $.facts[${index}] must be an object with fact, source_refs and established_by; got ${jsonType(entry)}`);
      continue;
    }
    const fact = entry as Record<string, unknown>;
    if (typeof fact.fact !== 'string' || !fact.fact.trim()) errors.push(`${label}: facts[${index}].fact must be non-empty`);
    if (!Array.isArray(fact.source_refs) || fact.source_refs.some((ref) => typeof ref !== 'string' || !ref.trim())) {
      errors.push(`${label}: facts[${index}].source_refs must be compact source references`);
    }
    if (typeof fact.established_by !== 'string' || !ESTABLISHED_BY.test(fact.established_by)) {
      errors.push(`${label}: facts[${index}].established_by must be "read" or "ran: <command>"`);
    }
    if ('source' in fact || 'transcript' in fact || 'suite' in fact) {
      errors.push(`${label}: facts[${index}] may not embed source, transcript, or suite copies`);
    }
  }
}

// Which addresses a Scenario drives is knowable in one place — the step file the
// worker just wrote — and until now it travelled nowhere. The coordinator owes
// the server one `surface_coverage` entry per Scenario, so on a2time, 2026-08-17,
// it assembled that join out of the workers' closing prose and its own plan. The
// independent reviewer read the step code instead, the two disagreed on six
// Scenarios, and the server refused the publication. The join now rides with the
// work that produced it, and the coordinator copies it instead of interpreting.
//
// Behavioral only: this is a join between Gherkin Scenarios and surfaces, and the
// structural branch has neither. Requiring the key there would refuse honest
// slices over a field that would mean nothing if they filled it in.
function validateSurfaceCoverage(
  value: unknown,
  item: Pick<WorkerPlanItem, 'branch' | 'capability_ids'>,
  label: string,
  errors: string[],
): void {
  if (value === undefined && item.branch !== 'behavioral') return;
  if (!Array.isArray(value)) {
    errors.push(`${label}: surface_coverage must be an array of {capability_id, scenario, surfaces} entries, one per Scenario written`);
    return;
  }
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label}: surface_coverage[${index}] must be an object with capability_id, scenario and surfaces; got ${jsonType(entry)}`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.capability_id !== 'string' || !item.capability_ids.includes(record.capability_id)) {
      errors.push(`${label}: surface_coverage[${index}].capability_id ${String(record.capability_id)} is not in this plan item`);
    }
    if (typeof record.scenario !== 'string' || !record.scenario.trim()) {
      errors.push(`${label}: surface_coverage[${index}].scenario must name the exact Scenario it covers`);
    }
    if (!Array.isArray(record.surfaces) || record.surfaces.length === 0
      || record.surfaces.some((surface) => typeof surface !== 'string' || !surface.trim())) {
      errors.push(`${label}: surface_coverage[${index}].surfaces must name at least one surface the Scenario drives`);
    }
  }
}

// Spec 41, criterion 1. Every assigned address ends in one of three places:
// driven by a Scenario, unreachable, or deferred. Only the first two are answers
// a worker can give — deferred is whatever is left, worked out where the upload
// is assembled, so a slice never has to enumerate what it did not do.
//
// a2time, 2026-09-05. Eight capabilities left 81 addresses in none of the three,
// and the server refused the publication after two hours. The workers were not
// careless: `deferred_surfaces` was only legal past the ceiling of twenty, six of
// those eight never came near it, and silence was the only move left. Widening
// the deferred bucket gave them a legal answer; computing it gave them a free
// one. What stays here is the pair the machine cannot work out on its own.
//
// Behavioral only, for the same reason as its neighbour: the structural branch
// has no addresses to account for.
function validateUnreachableSurfaces(
  value: unknown,
  item: Pick<WorkerPlanItem, 'branch' | 'capability_ids'>,
  coverage: unknown,
  assigned: Map<string, string[]>,
  label: string,
  errors: string[],
): void {
  if (value === undefined && item.branch !== 'behavioral') return;
  if (!Array.isArray(value)) {
    errors.push(`${label}: unreachable_surfaces must be an array of {surface, reason} entries, empty when the slice can drive everything it was given`);
    return;
  }

  const driven = new Set(drivenSurfaces(coverage));
  // Membership is measured against the addresses this slice's own capabilities
  // were given, never the whole assignment: a neighbour's address is as foreign
  // as an invented one.
  const mine = item.capability_ids.flatMap((id) => assigned.get(id) ?? []);
  const known = new Set(mine);
  const seen = new Set<string>();

  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label}: unreachable_surfaces[${index}] must be an object with surface and reason; got ${jsonType(entry)}`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const surface = record.surface;
    if (typeof surface !== 'string' || !surface.trim()) {
      errors.push(`${label}: unreachable_surfaces[${index}].surface must name one address`);
      continue;
    }
    // A reason per address, never one reason for a list. A sentence you cannot
    // write about *this* address is the signal it is not really unreachable —
    // which is the whole guard, and the reason this bucket stays narrow while
    // its neighbour widened.
    if (typeof record.reason !== 'string' || !record.reason.trim()) {
      errors.push(`${label}: unreachable_surfaces[${index}].reason must say what has to happen elsewhere for ${surface} to be called`);
    }
    if (driven.has(surface)) {
      errors.push(`${label}: ${surface} is driven by a Scenario and declared unreachable — it is one or the other`);
    }
    // Only when the assignment actually listed addresses for this capability.
    // An assignment that says nothing cannot say a surface is foreign, and
    // refusing there would refuse honest slices over an absence.
    if (known.size > 0 && !known.has(surface)) {
      errors.push(`${label}: ${surface} was not assigned to this slice`);
    }
    if (seen.has(surface)) errors.push(`${label}: unreachable_surfaces names ${surface} more than once`);
    else seen.add(surface);
  }
}

function drivenSurfaces(coverage: unknown): string[] {
  if (!Array.isArray(coverage)) return [];
  return coverage.flatMap((entry) => {
    const surfaces = (entry as Record<string, unknown> | null)?.surfaces;
    return Array.isArray(surfaces) ? surfaces.filter((surface): surface is string => typeof surface === 'string') : [];
  });
}

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
