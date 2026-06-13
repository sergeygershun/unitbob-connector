import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Recipe } from '../wire.ts';

// The task the host reads: where the project is, which map it was cut from,
// where to write the answer, the generate recipe, and the per-block packets. The
// connector carries `map_digest` here so the upload can echo the map it was
// given rather than trusting the host's answer file.
export interface SuiteBuildRequest {
  project_root: string;
  map_digest: string;
  output_path: string;
  recipe: Recipe;
  packets: unknown[];
}

export function requestPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'request.json');
}

export function outputPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'suite_output.json');
}

export function writeSuiteBuildRequest(
  projectRoot: string,
  task: { map_digest: string; recipe: Recipe; packets: unknown[] },
): SuiteBuildRequest {
  const request: SuiteBuildRequest = {
    project_root: projectRoot,
    map_digest: task.map_digest,
    output_path: outputPath(projectRoot),
    recipe: task.recipe,
    packets: task.packets,
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
    throw new Error(`${path} is malformed: expected project_root, map_digest, output_path, recipe, and packets.`);
  }

  return request;
}

// Read and parse the host's answer file. The connector verifies it parses and
// carries a `blocks` array, then relays it untouched — it never reads inside a
// block. Anything unparseable means we upload nothing (all-or-nothing).
export function readHostSuiteOutput(path: string): { blocks: unknown[] } {
  if (!existsSync(path)) {
    throw new Error(`${path} not found — the host suite builder did not write its output.`);
  }

  const parsed = parseJson(readFileSync(path, 'utf8'), path);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).blocks)) {
    throw new Error(`${path} is malformed: expected an object with a "blocks" array.`);
  }

  return parsed as { blocks: unknown[] };
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
    Array.isArray(request.packets)
  );
}

function isRecipe(value: unknown): value is Recipe {
  if (!value || typeof value !== 'object') return false;
  const recipe = value as Record<string, unknown>;
  return typeof recipe.name === 'string' && typeof recipe.version === 'string' && typeof recipe.text === 'string';
}
