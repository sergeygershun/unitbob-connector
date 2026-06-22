import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Recipe } from '../wire.ts';

// The task the host reads: where the project is, which map it was cut from, where
// to write the answer, the generate recipe, and its per-block capability
// assignment. The connector carries `map_digest` here so the upload can echo the
// map it was given rather than trusting the host's answer file.
export interface SuiteBuildRequest {
  project_root: string;
  map_digest: string;
  output_path: string;
  recipe: Recipe;
  blocks: unknown[];
}

// The host's answer: the complete spec file (inline as `spec_rb`, or via a
// `spec_rb_path` the connector reads) plus the capability-keyed `test_metadata`.
export interface HostSuiteOutput {
  spec_rb: string;
  test_metadata: unknown;
}

export function requestPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'request.json');
}

export function outputPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'suite_output.json');
}

export function writeSuiteBuildRequest(
  projectRoot: string,
  task: { map_digest: string; recipe: Recipe; blocks: unknown[] },
): SuiteBuildRequest {
  const request: SuiteBuildRequest = {
    project_root: projectRoot,
    map_digest: task.map_digest,
    output_path: outputPath(projectRoot),
    recipe: task.recipe,
    blocks: task.blocks,
  };

  const path = requestPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

export function readSuiteBuildRequest(projectRoot: string): SuiteBuildRequest {
  const path = requestPath(projectRoot);
  if (!existsSync(path)) {
    throw new Error(`${path} not found — run \`npx unitbob suite-prepare\` first.`);
  }

  const request = parseJson(readFileSync(path, 'utf8'), path);
  if (!isSuiteBuildRequest(request)) {
    throw new Error(`${path} is malformed: expected project_root, map_digest, output_path, recipe, and blocks.`);
  }

  return request;
}

// Read and parse the host's answer. The host wrote and ran the whole spec file;
// the connector verifies it parses and carries `spec_rb` (inline or via
// `spec_rb_path`) plus `test_metadata`, then relays it untouched. Anything
// unparseable or incomplete means nothing is uploaded (all-or-nothing).
export function readHostSuiteOutput(path: string, projectRoot: string): HostSuiteOutput {
  if (!existsSync(path)) {
    throw new Error(`${path} not found — the host suite builder did not write its output.`);
  }

  const parsed = parseJson(readFileSync(path, 'utf8'), path) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${path} is malformed: expected an object with spec_rb (or spec_rb_path) and test_metadata.`);
  }

  if (!('test_metadata' in parsed)) {
    throw new Error(`${path} is malformed: missing test_metadata.`);
  }

  const specRb = resolveSpecRb(parsed, projectRoot, path);
  return { spec_rb: specRb, test_metadata: parsed.test_metadata };
}

function resolveSpecRb(parsed: Record<string, unknown>, projectRoot: string, path: string): string {
  if (typeof parsed.spec_rb === 'string' && parsed.spec_rb.trim()) return parsed.spec_rb;

  if (typeof parsed.spec_rb_path === 'string' && parsed.spec_rb_path.trim()) {
    const specPath = isAbsolute(parsed.spec_rb_path) ? parsed.spec_rb_path : join(projectRoot, parsed.spec_rb_path);
    if (!existsSync(specPath)) throw new Error(`${path}: spec_rb_path "${parsed.spec_rb_path}" does not exist.`);
    return readFileSync(specPath, 'utf8');
  }

  throw new Error(`${path} is malformed: expected a non-empty spec_rb or spec_rb_path.`);
}

function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message})`);
  }
}

function isSuiteBuildRequest(value: unknown): value is SuiteBuildRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.project_root === 'string' &&
    typeof request.map_digest === 'string' &&
    typeof request.output_path === 'string' &&
    isRecipe(request.recipe) &&
    Array.isArray(request.blocks)
  );
}

function isRecipe(value: unknown): value is Recipe {
  if (!value || typeof value !== 'object') return false;
  const recipe = value as Record<string, unknown>;
  return typeof recipe.name === 'string' && typeof recipe.version === 'string' && typeof recipe.text === 'string';
}
