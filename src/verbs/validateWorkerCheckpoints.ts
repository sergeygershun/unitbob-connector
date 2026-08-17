import { existsSync, readFileSync } from 'node:fs';
import type { Config } from '../config.ts';
import {
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

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
