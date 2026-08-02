import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, sep } from 'node:path';
import type { Recipe, SuitePacket } from '../wire.ts';
import type { RunnerEnvelope } from '../runner/manifest.ts';
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
  // The envelope the host copies into its answer, selected from the ones the
  // server offered. Absent only when this machine's stack matched none of them —
  // the host then composes it from the recipe, as it always used to.
  runner_manifest?: RunnerEnvelope;
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

// What the reviewer reads. The raw runner report is deliberately not here: it is
// the largest artifact in the whole build (on a mid-sized Rails app, half of
// everything the reviewer was being handed), and a review of what the step
// definitions assert has no use for it. It rides only when a known defect was
// supplied, because then the reviewer must cite which Scenario the defect turned
// red. The connector keeps its own copy either way — see
// `CandidateRunEvidenceFile`.
export interface BehavioralReviewRequest {
  candidate_digest: string;
  suite_file: unknown;
  capabilities: unknown;
  output_path: string;
  known_defect_context: KnownDefectContext;
  candidate_run?: CandidateRunEvidence;
  fixed_candidate_run?: CandidateRunEvidence;
}

// The connector's own record of the runs it made of this exact candidate, under
// the defect choice it was given. It is what the upload carries, so the evidence
// is never the reviewer's to restate.
export interface CandidateRunEvidenceFile {
  candidate_digest: string;
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

export function candidateRunPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'candidate-run.json');
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
  const evidence: CandidateRunEvidenceFile = {
    candidate_digest: candidateDigest,
    known_defect_context: knownDefectContext,
    candidate_run: { candidate_digest: candidateDigest, ...candidateRun },
    ...(fixedCandidateRun ? {
      fixed_candidate_run: { candidate_digest: candidateDigest, ...fixedCandidateRun },
    } : {}),
  };
  writeArtifact(candidateRunPath(projectRoot), evidence);

  const request: BehavioralReviewRequest = {
    candidate_digest: candidateDigest,
    suite_file: output.suite_file,
    capabilities: metadata?.capabilities,
    output_path: reviewOutputPath(projectRoot),
    known_defect_context: knownDefectContext,
    // Only a supplied defect gives the reviewer something to read a run for.
    ...(knownDefectContext.status === 'supplied' ? {
      candidate_run: evidence.candidate_run,
      ...(evidence.fixed_candidate_run ? { fixed_candidate_run: evidence.fixed_candidate_run } : {}),
    } : {}),
  };
  writeArtifact(reviewRequestPath(projectRoot), request);
  return request;
}

function writeArtifact(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
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
    throw new Error(`${path} ${staleReviewReason(projectRoot, review, output)}`);
  }
  if (!('bdd_quality_review' in review) || !('known_defect_probe' in review)) {
    throw new Error(`${path} must contain bdd_quality_review and known_defect_probe.`);
  }
  const evidence = readCandidateRunEvidence(projectRoot, output);
  return {
    ...review,
    candidate_run: evidence.candidate_run,
    ...(evidence.fixed_candidate_run ? { fixed_candidate_run: evidence.fixed_candidate_run } : {}),
  } as unknown as BehavioralReviewArtifact;
}

// Why a review does not bind — two different mistakes with one symptom.
//
// The likelier one, now that a branch may answer with a bare `{ path }`: the
// review was right when it was written, and the candidate changed afterwards.
// Editing one step file is enough, and nothing in the answer has to change for
// it — so the digest moves with no visible cause, and "this does not review the
// current candidate" sends the reader off to audit the reviewer instead of their
// own last edit.
//
// The connector's own evidence file settles which mistake it was: it carries the
// digest of the candidate that was actually run at review time. Agreeing with
// the review and disagreeing with what is on disk now means the candidate moved
// after the review. Otherwise the review really is about a different candidate.
function staleReviewReason(
  projectRoot: string,
  review: Record<string, unknown> | null,
  output: HostBranchOutput,
): string {
  const evidencePath = candidateRunPath(projectRoot);
  if (review && existsSync(evidencePath)) {
    const evidence = parseJson(readFileSync(evidencePath, 'utf8'), evidencePath) as Record<string, unknown> | null;
    if (evidence && evidence.candidate_digest === review.candidate_digest) {
      return 'reviewed this suite as it stood at review time, and it has changed since — re-run ' +
        '`unitbob suite-review-prepare` and have the reviewer look at the changed suite.';
    }
  }
  return 'does not review the current behavioral suite candidate.';
}

// The runs the connector made of this exact candidate, and the defect choice
// they were made under. One file, read on its own: the evidence the upload
// carries must not depend on what the reviewer was shown, and reaching back into
// the reviewer's request for the defect choice would have re-created exactly
// that dependency.
function readCandidateRunEvidence(projectRoot: string, output: HostBranchOutput): CandidateRunEvidenceFile {
  const path = candidateRunPath(projectRoot);
  if (!existsSync(path)) {
    throw new Error(`${path} not found — run \`unitbob suite-review-prepare\` to record the candidate's run.`);
  }
  const file = parseJson(readFileSync(path, 'utf8'), path) as Record<string, unknown> | null;
  const digest = suiteCandidateDigest(output);
  if (!file || file.candidate_digest !== digest || !isRunEvidence(file.candidate_run, digest)) {
    throw new Error(`${path} has no connector runner evidence for the current behavioral candidate.`);
  }

  // Demanded, not defaulted. `readKnownDefectContext` reads a missing field as
  // `not_supplied`, which is right for a file someone else may have written and
  // wrong here: the connector writes this one itself, always with the choice it
  // was given. Missing means the file is damaged, and taking it as "no defect
  // was supplied" would turn that into a silently skipped fixed-revision check.
  if (file.known_defect_context === undefined) {
    throw new Error(`${path} records no known_defect_context — run \`unitbob suite-review-prepare\` again.`);
  }
  const context = readKnownDefectContext(file.known_defect_context, path);
  if (context.status === 'supplied' && context.fixed_revision) {
    const fixed = file.fixed_candidate_run as Record<string, unknown> | undefined;
    if (!isRunEvidence(fixed, digest) || fixed?.revision !== context.fixed_revision) {
      throw new Error(`${path} has no connector runner evidence for fixed revision ${context.fixed_revision}.`);
    }
  }
  return file as unknown as CandidateRunEvidenceFile;
}

function isRunEvidence(value: unknown, digest: string): boolean {
  const run = value as Record<string, unknown> | undefined;
  return Boolean(
    run && run.candidate_digest === digest &&
    typeof run.revision === 'string' && run.revision &&
    typeof run.run_result === 'string' && run.run_result,
  );
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
  const { entries, rootFor } = openAnswer(path, request);
  return entries.map((entry) => readBranch(entry, rootFor, path, request.project_root));
}

// A branch whose entry could not be read at all, named so the caller can report
// it against that branch instead of against the whole answer.
export interface UnreadableBranch {
  suite_kind: string;
  message: string;
}

// The same read, but one branch's bad entry does not hide the next branch's.
//
// Spec 32-6, after review: the throwing form above stops at the first problem,
// so an unsafe path in one branch concealed every remaining problem in its peer
// — and the promise this validation was built on is that all problems are named
// in one pass. It also sank a finished peer branch, which is the exact rule spec
// 32-5 Phase 4 established against.
//
// What still throws is the answer as a whole: a file that is missing, is not
// JSON, or carries no branches array has no second problem to go and find,
// because there is no document left to read.
export function readHostSuiteOutputsPerBranch(
  path: string,
  request: SuiteBuildRequest,
): { outputs: HostBranchOutput[]; unreadable: UnreadableBranch[] } {
  const { entries, rootFor } = openAnswer(path, request);
  const outputs: HostBranchOutput[] = [];
  const unreadable: UnreadableBranch[] = [];

  for (const entry of entries) {
    try {
      outputs.push(readBranch(entry, rootFor, path, request.project_root));
    } catch (err) {
      const kind = (entry as Record<string, unknown> | null)?.suite_kind;
      unreadable.push({
        suite_kind: typeof kind === 'string' && kind ? kind : 'unknown branch',
        message: (err as Error).message,
      });
    }
  }

  return { outputs, unreadable };
}

function openAnswer(
  path: string,
  request: SuiteBuildRequest,
): { entries: unknown[]; rootFor: Map<string, string> } {
  if (!existsSync(path)) {
    throw new Error(`${path} not found — the host suite builder did not write its output.`);
  }

  const parsed = parseJson(readFileSync(path, 'utf8'), path) as Record<string, unknown> | null;
  const branches = parsed && Array.isArray(parsed.branches) ? parsed.branches : null;
  if (!branches) {
    throw new Error(`${path} is malformed: expected a branches array, one entry per contract system.`);
  }

  return {
    entries: branches,
    rootFor: new Map(request.branches.map((branch) => [branch.suite_kind, branch.path_root])),
  };
}

function readBranch(entry: unknown, rootFor: Map<string, string>, path: string, projectRoot: string): HostBranchOutput {
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
    suite_file: resolveSuiteFile(branch.suite_file, root, path, suiteKind, projectRoot),
    runner_manifest: manifest,
    test_metadata: branch.test_metadata,
  };
}

interface EnvelopeFile {
  path: string;
  content: string;
  support_files?: { path: string; content: string }[];
}

// Each path is checked safe under this branch's root before anything is
// accepted. `content` may be inlined, but it does not have to be: the host wrote
// and ran these files on disk before answering, so a bare `{ path }` means "the
// file already under that path is the answer". Re-serializing a whole suite into
// this JSON on every rebuild was the single largest cost in the build loop, and
// the copy was never more trustworthy than the file that was actually executed.
function resolveSuiteFile(
  file: unknown,
  root: string,
  path: string,
  suiteKind: string,
  projectRoot: string,
): EnvelopeFile {
  if (!file || typeof file !== 'object') {
    throw new Error(`${path}: the ${suiteKind} branch is missing suite_file.`);
  }
  const envelope = file as Record<string, unknown>;
  const main = readOneFile(envelope, root, path, suiteKind, false, projectRoot);
  const support = Array.isArray(envelope.support_files)
    ? envelope.support_files.map((entry) =>
      readOneFile(entry as Record<string, unknown>, root, path, suiteKind, true, projectRoot))
    : [];
  return support.length > 0 ? { ...main, support_files: support } : main;
}

function readOneFile(
  file: Record<string, unknown>,
  root: string,
  path: string,
  suiteKind: string,
  support: boolean,
  projectRoot: string,
): { path: string; content: string } {
  const filePath = typeof file.path === 'string' ? file.path : '';
  assertUnitbobPath(filePath, root);

  if (typeof file.content === 'string' && file.content.trim()) {
    return { path: filePath, content: file.content };
  }
  if (file.content !== undefined) {
    throw new Error(`${path}: the ${suiteKind} ${fileLabel(support)} at "${filePath}" has empty content.`);
  }

  const onDisk = join(projectRoot, filePath);
  if (!existsSync(onDisk)) {
    throw new Error(
      `${path}: the ${suiteKind} ${fileLabel(support)} names "${filePath}", but no such file exists — write it before answering, or inline its content.`,
    );
  }
  // `assertUnitbobPath` judges the path text; it cannot see that a safe-looking
  // name is a link out of the suite root — nor that the directory holding it is.
  // Inlined content could never reach outside the answer, so reading from disk
  // is where that check has to be made: these bytes are uploaded.
  //
  // Only the project root is resolved, and the suite root is then joined onto it
  // as text. Resolving the suite root too would let a linked `.unitbob/<kind>/`
  // vouch for itself — every file under it resolves neatly under the link's own
  // target. Resolving nothing at all would fail honest projects instead, because
  // a macOS temp or home path is itself reached through a link.
  // The wire's `path_root` carries a trailing slash; `join` keeps it.
  const suiteRoot = join(realpathSync(projectRoot), root).replace(/[\\/]+$/, '');
  if (!realpathSync(onDisk).startsWith(`${suiteRoot}${sep}`)) {
    throw new Error(
      `${path}: the ${suiteKind} ${fileLabel(support)} at "${filePath}" resolves outside the suite root — suite files must be real files under it.`,
    );
  }
  const content = readFileSync(onDisk, 'utf8');
  if (!content.trim()) {
    throw new Error(`${path}: the ${suiteKind} ${fileLabel(support)} at "${filePath}" is empty.`);
  }
  return { path: filePath, content };
}

function fileLabel(support: boolean): string {
  return support ? 'support file' : 'suite_file';
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
