import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Recipe, SuitePacket } from '../wire.ts';
import { assertUnitbobPath } from './artifactPath.ts';

// The task the host reads (spec 32): the two peer assignments to build, one per
// contract system, each with its recipe, its source digest, its path root, and
// its opaque assignment body. The connector carries the source digests here so
// the batch upload can echo the map each branch was given rather than trusting
// the host's answer.
export interface SuiteBuildBranch {
  suite_kind: string;
  source_digest: string;
  path_root: string;
  recipe: Recipe;
  assignment: unknown;
}

export interface SuiteBuildRequest {
  project_root: string;
  output_path: string;
  branches: SuiteBuildBranch[];
}

// The host's answer: one entry per branch it built, keyed by suite_kind. A
// branch the host could not build carries a `build_error`; a built branch
// carries the verbatim artifact envelope { suite_file, runner_manifest,
// test_metadata }.
export interface HostBranchOutput {
  suite_kind: string;
  suite_file?: unknown;
  runner_manifest?: unknown;
  test_metadata?: unknown;
  build_error?: { message: string };
}

export function requestPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'request.json');
}

export function outputPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'suite_output.json');
}

export function writeSuiteBuildRequest(projectRoot: string, branches: SuiteBuildBranch[]): SuiteBuildRequest {
  const request: SuiteBuildRequest = {
    project_root: projectRoot,
    output_path: outputPath(projectRoot),
    branches,
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

  const request = parseJson(readFileSync(path, 'utf8'), path) as Record<string, unknown> | null;
  if (
    !request ||
    typeof request.project_root !== 'string' ||
    typeof request.output_path !== 'string' ||
    !Array.isArray(request.branches)
  ) {
    throw new Error(`${path} is malformed: expected project_root, output_path, and a branches array.`);
  }
  return request as unknown as SuiteBuildRequest;
}

// Read the host's answers, one per branch. The connector verifies each built
// branch parses, carries a safe-path artifact envelope under its own root, and
// has a runner_manifest and test_metadata. A branch may instead carry a
// build_error, which the connector relays. Anything unparseable throws and
// nothing is uploaded.
export function readHostSuiteOutputs(path: string, request: SuiteBuildRequest): HostBranchOutput[] {
  if (!existsSync(path)) {
    throw new Error(`${path} not found — the host suite builder did not write its output.`);
  }

  const parsed = parseJson(readFileSync(path, 'utf8'), path) as Record<string, unknown> | null;
  const branches = parsed && Array.isArray(parsed.branches) ? parsed.branches : null;
  if (!branches) {
    throw new Error(`${path} is malformed: expected a branches array, one entry per contract system.`);
  }

  const rootFor = new Map(request.branches.map((branch) => [branch.suite_kind, branch.path_root]));
  return branches.map((entry) => readBranch(entry, rootFor, path));
}

function readBranch(entry: unknown, rootFor: Map<string, string>, path: string): HostBranchOutput {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`${path} is malformed: each branch must be an object.`);
  }
  const branch = entry as Record<string, unknown>;
  const suiteKind = String(branch.suite_kind ?? '');
  const root = rootFor.get(suiteKind);
  if (!root) {
    throw new Error(`${path}: unknown suite_kind "${suiteKind}" — it was not in the build request.`);
  }

  if ('spec_rb' in branch || 'spec_rb_path' in branch) {
    throw new Error(`${path}: the ${suiteKind} branch uses the legacy spec_rb shape — emit suite_file instead.`);
  }

  if (branch.build_error && typeof branch.build_error === 'object') {
    const message = String(
      (branch.build_error as Record<string, unknown>).message ?? 'the host could not build this suite',
    );
    return { suite_kind: suiteKind, build_error: { message } };
  }

  if (!('test_metadata' in branch)) {
    throw new Error(`${path}: the ${suiteKind} branch is missing test_metadata.`);
  }
  const manifest = branch.runner_manifest;
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`${path}: the ${suiteKind} branch is missing runner_manifest.`);
  }

  return {
    suite_kind: suiteKind,
    suite_file: resolveSuiteFile(branch.suite_file, root, path, suiteKind),
    runner_manifest: manifest,
    test_metadata: branch.test_metadata,
  };
}

interface EnvelopeFile {
  path: string;
  content: string;
  support_files?: { path: string; content: string }[];
}

// The host inlines every file's `content`; each path is checked safe under this
// branch's root before anything is accepted.
function resolveSuiteFile(file: unknown, root: string, path: string, suiteKind: string): EnvelopeFile {
  if (!file || typeof file !== 'object') {
    throw new Error(`${path}: the ${suiteKind} branch is missing suite_file.`);
  }
  const envelope = file as Record<string, unknown>;
  const main = readOneFile(envelope, root, path, suiteKind, false);
  const support = Array.isArray(envelope.support_files)
    ? envelope.support_files.map((entry) => readOneFile(entry as Record<string, unknown>, root, path, suiteKind, true))
    : [];
  return support.length > 0 ? { ...main, support_files: support } : main;
}

function readOneFile(
  file: Record<string, unknown>,
  root: string,
  path: string,
  suiteKind: string,
  support: boolean,
): { path: string; content: string } {
  const filePath = typeof file.path === 'string' ? file.path : '';
  assertUnitbobPath(filePath, root);

  if (typeof file.content === 'string' && file.content.trim()) {
    return { path: filePath, content: file.content };
  }
  const label = support ? 'support file' : 'suite_file';
  throw new Error(`${path}: the ${suiteKind} ${label} at "${filePath}" has no inline content.`);
}

function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message})`);
  }
}

// Turn a branch's assignment packet into its recipe name: structural uses the
// unit-guardrail recipe, behavioral the Gherkin one.
export function recipeNameFor(packet: SuitePacket): string {
  return packet.suite_kind === 'behavioral' ? 'generate_behavioral' : 'generate';
}
