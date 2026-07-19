import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Recipe } from '../wire.ts';
import { assertGuardrailPath, type SuiteFile } from './guardrails.ts';

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

// The host's answer (spec 30): the single generated guardrail file as
// `suite_file { path, content }` (content inline, or read from the file the
// host already wrote at that path), the suite-level `runner_manifest`, and the
// capability-keyed `test_metadata`. The legacy `spec_rb` shape is rejected.
export interface HostSuiteOutput {
  suite_file: SuiteFile;
  runner_manifest: unknown;
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

// Read and parse the host's answer. The host wrote and ran the whole guardrail
// file; the connector verifies the answer parses, carries `suite_file` (with a
// safe path under .unitbob/guardrails/), `runner_manifest`, and
// `test_metadata`, then relays it untouched. Anything unparseable or
// incomplete means nothing is uploaded (all-or-nothing).
export function readHostSuiteOutput(path: string, projectRoot: string): HostSuiteOutput {
  if (!existsSync(path)) {
    throw new Error(`${path} not found — the host suite builder did not write its output.`);
  }

  const parsed = parseJson(readFileSync(path, 'utf8'), path) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${path} is malformed: expected an object with suite_file, runner_manifest, and test_metadata.`);
  }

  if ('spec_rb' in parsed || 'spec_rb_path' in parsed) {
    throw new Error(`${path} uses the legacy spec_rb shape — emit suite_file { path, content } instead (spec 30).`);
  }

  if (!('test_metadata' in parsed)) {
    throw new Error(`${path} is malformed: missing test_metadata.`);
  }

  const manifest = parsed.runner_manifest;
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`${path} is malformed: missing runner_manifest.`);
  }

  return {
    suite_file: resolveSuiteFile(parsed, projectRoot, path),
    runner_manifest: manifest,
    test_metadata: parsed.test_metadata,
  };
}

// The host may inline `content` or point at the file it already wrote at
// `suite_file.path` — either way the path must be safe before anything is read.
function resolveSuiteFile(parsed: Record<string, unknown>, projectRoot: string, path: string): SuiteFile {
  const file = parsed.suite_file;
  if (!file || typeof file !== 'object') {
    throw new Error(`${path} is malformed: expected suite_file { path, content }.`);
  }

  const suiteFile = file as Record<string, unknown>;
  const suitePath = typeof suiteFile.path === 'string' ? suiteFile.path : '';
  assertGuardrailPath(suitePath);

  if (typeof suiteFile.content === 'string' && suiteFile.content.trim()) {
    return { path: suitePath, content: suiteFile.content };
  }

  const onDisk = join(projectRoot, suitePath);
  if (!existsSync(onDisk)) {
    throw new Error(`${path}: suite_file has no content and "${suitePath}" does not exist in the project.`);
  }

  const content = readFileSync(onDisk, 'utf8');
  if (!content.trim()) {
    throw new Error(`${path}: suite_file content at "${suitePath}" is empty.`);
  }
  return { path: suitePath, content };
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
