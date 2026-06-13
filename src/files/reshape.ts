import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Recipe, ReshapePacket } from '../wire.ts';

// The reshape task the host reads (spec 21): where the project is, which test to
// reshape, which suite_digest it builds on, where to write its one new body, the
// generate recipe, and the single-element packet. The host writes **one test
// body** (not a runnable file) to `output_path`; Rails owns the suite header.
export interface ReshapeRequest {
  project_root: string;
  test_id: string;
  suite_digest: string;
  output_path: string;
  recipe: Recipe;
  packet: unknown;
}

// The host's answer: exactly one regenerated test body in business language. An
// empty/missing body means nothing is uploaded and the previous suite stands.
export interface ReshapeOutput {
  headline?: string;
  description?: string;
  body: string;
}

const RESHAPE_DIR = ['.unitbob', 'reshape'];

export function requestPath(projectRoot: string): string {
  return join(projectRoot, ...RESHAPE_DIR, 'request.json');
}

export function outputPath(projectRoot: string): string {
  return join(projectRoot, ...RESHAPE_DIR, 'reshape_output.json');
}

export function candidateSpecPath(projectRoot: string): string {
  return join(projectRoot, ...RESHAPE_DIR, 'candidate_spec.rb');
}

export function writeReshapeRequest(projectRoot: string, testId: string, packet: ReshapePacket): ReshapeRequest {
  const request: ReshapeRequest = {
    project_root: projectRoot,
    test_id: testId,
    suite_digest: packet.suite_digest,
    output_path: outputPath(projectRoot),
    recipe: packet.recipe,
    packet: packet.packet,
  };

  const path = requestPath(projectRoot);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

export function readReshapeRequest(projectRoot: string): ReshapeRequest {
  const path = requestPath(projectRoot);
  if (!existsSync(path)) {
    throw new Error(`${path} not found — run \`npx unitbob reshape-prepare <test_id>\` first.`);
  }

  const parsed = parseJson(readFileSync(path, 'utf8'), path);
  if (!isReshapeRequest(parsed)) {
    throw new Error(`${path} is malformed: expected project_root, test_id, suite_digest, output_path, recipe, and packet.`);
  }

  return parsed;
}

// Read and validate the host's one new body. A missing file, unparseable JSON,
// or an empty/missing `body` all throw — the caller then uploads nothing (M2).
export function readReshapeOutput(path: string): ReshapeOutput {
  if (!existsSync(path)) {
    throw new Error(`${path} not found — the host reshaper did not write its output.`);
  }

  const parsed = parseJson(readFileSync(path, 'utf8'), path) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.body !== 'string' || parsed.body.trim() === '') {
    throw new Error(`${path} is malformed: expected an object with a non-empty "body" string.`);
  }

  return {
    body: parsed.body,
    headline: typeof parsed.headline === 'string' ? parsed.headline : undefined,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
  };
}

export function writeCandidateSpec(projectRoot: string, candidateSpec: string): string {
  const path = candidateSpecPath(projectRoot);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, candidateSpec);
  return path;
}

function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message})`);
  }
}

function isReshapeRequest(value: unknown): value is ReshapeRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.project_root === 'string' &&
    typeof request.test_id === 'string' &&
    typeof request.suite_digest === 'string' &&
    typeof request.output_path === 'string' &&
    isRecipe(request.recipe) &&
    'packet' in request
  );
}

function isRecipe(value: unknown): value is Recipe {
  if (!value || typeof value !== 'object') return false;
  const recipe = value as Record<string, unknown>;
  return typeof recipe.name === 'string' && typeof recipe.version === 'string' && typeof recipe.text === 'string';
}
