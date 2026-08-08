import { existsSync, readFileSync } from 'node:fs';
import type { Config } from '../config.ts';
import {
  checkpointPath,
  readWorkerPlan,
  requestDigest,
  validateWorkerPlanFiles,
  workerPlanDigest,
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

function validateCompactFacts(value: unknown, label: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${label}: facts must be an array`);
    return;
  }
  for (const [index, entry] of value.entries()) {
    const fact = entry as Record<string, unknown>;
    if (!fact || typeof fact.fact !== 'string' || !fact.fact.trim()) errors.push(`${label}: facts[${index}].fact must be non-empty`);
    if (!Array.isArray(fact?.source_refs) || fact.source_refs.some((ref) => typeof ref !== 'string' || !ref.trim())) {
      errors.push(`${label}: facts[${index}].source_refs must be compact source references`);
    }
    if ('source' in (fact ?? {}) || 'transcript' in (fact ?? {}) || 'suite' in (fact ?? {})) {
      errors.push(`${label}: facts[${index}] may not embed source, transcript, or suite copies`);
    }
  }
}
