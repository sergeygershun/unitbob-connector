import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FeatureUpload, Recipe } from '../wire.ts';

// The task the host reads to name what a change may touch (spec 52-1). It
// carries the recipe, the product capabilities of the current map as the
// behavioral suite packet lists them, and the two local folders the host may
// read for more — each only when it is actually on disk. Today's check
// statuses are not here: they are for the feature's page, not for the judgement.
//
// The intent itself is not in the file either. It is what the person said in
// the conversation, and the host copies it into the answer as said.
export interface Capability {
  capability_id: string;
  title: string;
  description: string;
  surfaces: string[];
  tables: string[];
  externals: string[];
}

export interface FeatureStartRequest {
  project_root: string;
  recipe: Recipe;
  capabilities: Capability[];
  behavioral_suite_path: string | null;
  map_documents_path: string | null;
  output_path: string;
}

export function requestPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'feature-start', 'request.json');
}

export function outputPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'feature-start', 'feature.json');
}

export function writeFeatureStartRequest(
  projectRoot: string,
  recipe: Recipe,
  capabilities: Capability[],
): FeatureStartRequest {
  const request: FeatureStartRequest = {
    project_root: projectRoot,
    recipe,
    capabilities,
    behavioral_suite_path: presentDir(join(projectRoot, '.unitbob', 'behavioral')),
    map_documents_path: presentDir(join(projectRoot, '.unitbob', 'map-build')),
    output_path: outputPath(projectRoot),
  };

  const path = requestPath(projectRoot);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

// The host's answer in the wire shape, and nothing else: a field it added is
// dropped here rather than sent on. Each check names the field it failed, so
// the host corrects the file instead of guessing what was wrong with it.
export function readFeatureAnswer(projectRoot: string): FeatureUpload {
  const path = outputPath(projectRoot);
  if (!existsSync(path)) {
    throw new Error(`No feature answer at ${path}. Write it as the recipe describes, then run \`unitbob put-feature\`.`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path} must hold a JSON object with "title", "intent" and "affected".`);
  }

  const body = raw as Record<string, unknown>;
  const title = nonEmptyString(body.title, 'title', path);
  const intent = nonEmptyString(body.intent, 'intent', path);
  if (!Array.isArray(body.affected)) {
    throw new Error(`${path}: "affected" must be an array of { id, why } (it may be empty).`);
  }
  const affected = body.affected.map((entry, index) => {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    return {
      id: nonEmptyString(item.id, `affected[${index}].id`, path),
      why: typeof item.why === 'string' ? item.why : '',
    };
  });

  return { title, intent, affected };
}

function nonEmptyString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${path}: "${field}" must be a non-empty string.`);
  }
  return value;
}

function presentDir(path: string): string | null {
  return existsSync(path) ? path : null;
}
