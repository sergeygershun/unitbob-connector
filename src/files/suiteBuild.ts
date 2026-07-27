import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  known_defect_context: KnownDefectContext;
}

export type KnownDefectContext =
  | { status: 'not_supplied' }
  | { status: 'supplied'; defect: string; fixed_revision?: string };

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

export interface BehavioralReviewArtifact {
  candidate_digest: string;
  bdd_quality_review: unknown;
  known_defect_probe: unknown;
  candidate_run: CandidateRunEvidence;
  fixed_candidate_run?: CandidateRunEvidence;
}

export interface CandidateRunEvidence {
  candidate_digest: string;
  revision: string;
  run_result: string;
}

export interface BehavioralReviewRequest {
  candidate_digest: string;
  suite_file: unknown;
  capabilities: unknown;
  output_path: string;
  known_defect_context: KnownDefectContext;
  candidate_run: CandidateRunEvidence;
  fixed_candidate_run?: CandidateRunEvidence;
}

export function requestPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'request.json');
}

export function outputPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'suite_output.json');
}

export function reviewOutputPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'behavioral_review.json');
}

export function reviewRequestPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'review-request.json');
}

export function writeBehavioralReviewRequest(
  projectRoot: string,
  output: HostBranchOutput,
  candidateRun: Omit<CandidateRunEvidence, 'candidate_digest'>,
  knownDefectContext: KnownDefectContext = { status: 'not_supplied' },
  fixedCandidateRun?: Omit<CandidateRunEvidence, 'candidate_digest'>,
): BehavioralReviewRequest {
  const metadata = output.test_metadata as Record<string, unknown> | undefined;
  const candidateDigest = suiteCandidateDigest(output);
  const request: BehavioralReviewRequest = {
    candidate_digest: candidateDigest,
    suite_file: output.suite_file,
    capabilities: metadata?.capabilities,
    output_path: reviewOutputPath(projectRoot),
    known_defect_context: knownDefectContext,
    candidate_run: { candidate_digest: candidateDigest, ...candidateRun },
    ...(fixedCandidateRun ? {
      fixed_candidate_run: { candidate_digest: candidateDigest, ...fixedCandidateRun },
    } : {}),
  };
  const path = reviewRequestPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

// The connector-owned runner strategy this branch selected. Reading it out of
// the envelope is transport, like every other `runner_manifest` access in this
// module — callers only ever get back the strategy name they dispatch on.
export function branchRunner(output: HostBranchOutput): string {
  const manifest = output.runner_manifest as Record<string, unknown> | undefined;
  const runner = manifest?.runner;
  if (typeof runner !== 'string' || !runner) {
    throw new Error('The behavioral candidate names no runner strategy to execute.');
  }
  return runner;
}

export function suiteCandidateDigest(output: HostBranchOutput): string {
  return createHash('sha256')
    .update(stableJson({
      suite_file: output.suite_file,
      runner_manifest: output.runner_manifest,
      test_metadata: output.test_metadata,
    }))
    .digest('hex');
}

// Everything the server strips back out before it recomputes the candidate
// digest. The generator owns none of it, and if it writes any of these keys the
// two sides hash different objects — which surfaces as "this review is about a
// different candidate", blaming the reviewer for the generator's mistake. Refuse
// it here, where the real cause can still be named.
const POST_CANDIDATE_METADATA_KEYS = [
  'bdd_quality_review',
  'known_defect_probe',
  'known_defect_context',
  'candidate_run',
  'fixed_candidate_run',
];

export function readBehavioralReview(projectRoot: string, output: HostBranchOutput): BehavioralReviewArtifact {
  const metadata = output.test_metadata as Record<string, unknown> | undefined;
  const embedded = metadata ? POST_CANDIDATE_METADATA_KEYS.filter((key) => key in metadata) : [];
  if (embedded.length > 0) {
    throw new Error(
      `The behavioral suite generator must not embed its own review (found ${embedded.join(', ')} in test_metadata); run \`unitbob suite-review-prepare\` and provide the separate review artifact.`,
    );
  }

  const path = reviewOutputPath(projectRoot);
  if (!existsSync(path)) {
    throw new Error(`${path} not found — run \`unitbob suite-review-prepare\` and have an independent reviewer write it.`);
  }
  const review = parseJson(readFileSync(path, 'utf8'), path) as Record<string, unknown> | null;
  if (!review || review.candidate_digest !== suiteCandidateDigest(output)) {
    throw new Error(`${path} does not review the current behavioral suite candidate.`);
  }
  if (!('bdd_quality_review' in review) || !('known_defect_probe' in review)) {
    throw new Error(`${path} must contain bdd_quality_review and known_defect_probe.`);
  }
  const request = readBehavioralReviewRequest(projectRoot, output);
  return {
    ...review,
    candidate_run: request.candidate_run,
    ...(request.fixed_candidate_run ? { fixed_candidate_run: request.fixed_candidate_run } : {}),
  } as unknown as BehavioralReviewArtifact;
}

function readBehavioralReviewRequest(projectRoot: string, output: HostBranchOutput): BehavioralReviewRequest {
  const path = reviewRequestPath(projectRoot);
  const request = parseJson(readFileSync(path, 'utf8'), path) as Record<string, unknown> | null;
  const run = request?.candidate_run as Record<string, unknown> | undefined;
  const digest = suiteCandidateDigest(output);
  if (!request || request.candidate_digest !== digest || !run || run.candidate_digest !== digest ||
      typeof run.revision !== 'string' || !run.revision || typeof run.run_result !== 'string' || !run.run_result) {
    throw new Error(`${path} has no connector runner evidence for the current behavioral candidate.`);
  }
  const context = request.known_defect_context as KnownDefectContext | undefined;
  if (context?.status === 'supplied' && context.fixed_revision) {
    const fixed = request.fixed_candidate_run as unknown as Record<string, unknown> | undefined;
    if (!fixed || fixed.candidate_digest !== digest || fixed.revision !== context.fixed_revision ||
        typeof fixed.run_result !== 'string' || !fixed.run_result) {
      throw new Error(`${path} has no connector runner evidence for fixed revision ${context.fixed_revision}.`);
    }
  }
  return request as unknown as BehavioralReviewRequest;
}

export function writeSuiteBuildRequest(
  projectRoot: string,
  branches: SuiteBuildBranch[],
  knownDefectContext: KnownDefectContext = { status: 'not_supplied' },
): SuiteBuildRequest {
  const request: SuiteBuildRequest = {
    project_root: projectRoot,
    output_path: outputPath(projectRoot),
    branches,
    known_defect_context: knownDefectContext,
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
  return {
    ...(request as unknown as SuiteBuildRequest),
    known_defect_context: readKnownDefectContext(request.known_defect_context, path),
  };
}

function readKnownDefectContext(value: unknown, path: string): KnownDefectContext {
  if (value === undefined) return { status: 'not_supplied' };
  if (!value || typeof value !== 'object') throw new Error(`${path}: known_defect_context must be an object.`);
  const context = value as Record<string, unknown>;
  if (context.status === 'not_supplied') return { status: 'not_supplied' };
  if (context.status !== 'supplied' || typeof context.defect !== 'string' || !context.defect.trim()) {
    throw new Error(`${path}: supplied known_defect_context must name a defect.`);
  }
  if (context.fixed_revision !== undefined &&
      (typeof context.fixed_revision !== 'string' || !context.fixed_revision.trim())) {
    throw new Error(`${path}: fixed_revision must be a non-empty string.`);
  }
  return {
    status: 'supplied',
    defect: context.defect,
    ...(context.fixed_revision ? { fixed_revision: context.fixed_revision as string } : {}),
  };
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// Turn a branch's assignment packet into its recipe name: structural uses the
// unit-guardrail recipe, behavioral the Gherkin one.
export function recipeNameFor(packet: SuitePacket): string {
  return packet.suite_kind === 'behavioral' ? 'generate_behavioral' : 'generate';
}
