import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveSuiteFile } from './suiteBuild.ts';
import type { KnowledgePacket, Recipe, RunnerManifestWire, SuiteArtifact, TestsPacket } from '../wire.ts';

// A feature's folder on disk (spec 52-2): `.unitbob/features/<id>/`. This is
// the first spec that gives a feature a folder; the talk's request and the
// file it folds into live here, and spec 52-3 puts its own request beside them.
export function featureDir(projectRoot: string, featureId: number | string): string {
  return join(projectRoot, '.unitbob', 'features', String(featureId));
}

// The id as the list printed it and the folder is named: a number. A word
// ("refunds") is the person's, not the server's, and the verb says so.
export function parseFeatureId(raw: string | undefined, verb: string): number {
  if (raw === undefined) throw new Error(`Usage: unitbob ${verb} <feature_id>`);
  if (!/^\d+$/.test(raw)) throw new Error(`unitbob ${verb}: the feature id must be a number, got "${raw}".`);
  return Number(raw);
}

export function knowledgeRequestPath(projectRoot: string, featureId: number | string): string {
  return join(featureDir(projectRoot, featureId), 'request.json');
}

export function knowledgePath(projectRoot: string, featureId: number | string): string {
  return join(featureDir(projectRoot, featureId), 'knowledge.md');
}

// The task the host reads to talk the feature through: the recipe, the packet
// the server built (the feature, each affected promise with its state in the
// server's words, an earlier knowledge text if the talk was held before), the
// two local folders the host may read for facts — each only when it is on
// disk — and where `knowledge.md` goes.
export interface KnowledgeRequest {
  project_root: string;
  recipe: Recipe;
  feature: KnowledgePacket['feature'];
  affected: KnowledgePacket['affected'];
  knowledge: string | null;
  behavioral_suite_path: string | null;
  map_documents_path: string | null;
  output_path: string;
}

export function writeKnowledgeRequest(
  projectRoot: string,
  featureId: number | string,
  recipe: Recipe,
  packet: KnowledgePacket,
): KnowledgeRequest {
  const request: KnowledgeRequest = {
    project_root: projectRoot,
    recipe,
    feature: packet.feature,
    affected: packet.affected,
    knowledge: packet.knowledge,
    behavioral_suite_path: presentDir(join(projectRoot, '.unitbob', 'behavioral')),
    map_documents_path: presentDir(join(projectRoot, '.unitbob', 'map-build')),
    output_path: knowledgePath(projectRoot, featureId),
  };

  const path = knowledgeRequestPath(projectRoot, featureId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

// The file as text, and nothing else: the server is the one place that checks
// its shape (spec 52-2, Non-Goals), so the connector only refuses to send
// nothing.
export function readKnowledge(projectRoot: string, featureId: number | string): string {
  const path = knowledgePath(projectRoot, featureId);
  if (!existsSync(path)) {
    throw new Error(`No knowledge file at ${path}. Write it as the recipe describes, then run \`unitbob put-knowledge\`.`);
  }
  const text = readFileSync(path, 'utf8');
  if (text.trim() === '') throw new Error(`${path} is empty. Write it as the recipe describes, then run \`unitbob put-knowledge\`.`);
  return text;
}

function presentDir(path: string): string | null {
  return existsSync(path) ? path : null;
}

// --- the checks (spec 52-3) -------------------------------------------------

export function testsRequestPath(projectRoot: string, featureId: number | string): string {
  return join(featureDir(projectRoot, featureId), 'tests-request.json');
}

export function testsOutputPath(projectRoot: string, featureId: number | string): string {
  return join(featureDir(projectRoot, featureId), 'tests-output.json');
}

// Where the checks go, beside the main suite (spec 52-3, AC 3.4): one
// `.feature` and one step file, both named after the feature so that they can
// never take a path of the main suite's.
export function featureFeaturePath(featureId: number | string): string {
  return `.unitbob/behavioral/features/feature_${featureId}.feature`;
}

export function featureStepsPath(featureId: number | string, runner: string): string {
  return `.unitbob/behavioral/step_definitions/${stepsFileName(featureId, runner)}`;
}

// Named as the runner collects it: pytest only picks up `test_*.py`, and a
// file named otherwise loads nothing (`bdd.ts` says so at length).
function stepsFileName(featureId: number | string, runner: string): string {
  switch (runner) {
    case 'pytest-bdd': return `test_feature_${featureId}_steps.py`;
    case 'cucumber-js': return `feature_${featureId}_steps.js`;
    default: return `feature_${featureId}_steps.rb`;
  }
}

// The task the host reads to write the checks: the recipe, the assignment
// with the identity already minted, the feature's tag, the scenarios to copy
// word for word, where the knowledge file is, the runner and its manifest to
// copy, the main suite's files to reuse steps from, the two paths to write,
// and where the answer goes.
export interface TestsRequest {
  project_root: string;
  recipe: Recipe;
  feature: TestsPacket['feature'];
  feature_tag: string;
  assignment: TestsPacket['assignment'];
  scenarios: TestsPacket['scenarios'];
  knowledge_path: string;
  knowledge_digest: string;
  runner: string;
  runner_manifest: RunnerManifestWire;
  main_suite: TestsPacket['main_suite'];
  feature_path: string;
  steps_path: string;
  output_path: string;
}

export function writeTestsRequest(projectRoot: string, featureId: number | string, request: TestsRequest): TestsRequest {
  const path = testsRequestPath(projectRoot, featureId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

export function readTestsRequest(projectRoot: string, featureId: number | string): TestsRequest {
  const path = testsRequestPath(projectRoot, featureId);
  if (!existsSync(path)) {
    throw new Error(`${path} not found — run \`npx unitbob tests-prepare ${featureId}\` first.`);
  }
  const request = JSON.parse(readFileSync(path, 'utf8')) as Partial<TestsRequest> | null;
  if (!request || typeof request.feature_tag !== 'string' || typeof request.runner !== 'string' ||
      typeof request.feature_path !== 'string' || typeof request.output_path !== 'string') {
    throw new Error(`${path} is malformed — run \`npx unitbob tests-prepare ${featureId}\` again.`);
  }
  return request as TestsRequest;
}

// The host's answer, the shape of one built branch: `suite_file` with paths
// (content read from disk under the behavioral root, as for a suite build),
// `runner_manifest`, `test_metadata`.
export interface TestsOutput {
  suite_file: SuiteArtifact;
  runner_manifest: RunnerManifestWire;
  test_metadata: Record<string, unknown>;
}

export function readTestsOutput(projectRoot: string, featureId: number | string): TestsOutput {
  const path = testsOutputPath(projectRoot, featureId);
  if (!existsSync(path)) {
    throw new Error(`${path} not found — write the answer as the recipe describes, then run \`unitbob put-tests\`.`);
  }
  const answer = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!answer || typeof answer !== 'object') throw new Error(`${path} is malformed: expected an object.`);
  const manifest = answer.runner_manifest;
  if (!manifest || typeof manifest !== 'object' || typeof (manifest as Record<string, unknown>).runner !== 'string') {
    throw new Error(`${path} is missing runner_manifest.`);
  }
  if (!answer.test_metadata || typeof answer.test_metadata !== 'object') {
    throw new Error(`${path} is missing test_metadata.`);
  }
  return {
    suite_file: resolveSuiteFile(answer.suite_file, '.unitbob/behavioral/', path, 'feature', projectRoot),
    runner_manifest: manifest as RunnerManifestWire,
    test_metadata: answer.test_metadata as Record<string, unknown>,
  };
}

// --- the review of the checks (spec 52-4, AC 1.11) ---------------------------

export function testsReviewRequestPath(projectRoot: string, featureId: number | string): string {
  return join(featureDir(projectRoot, featureId), 'tests-review-request.json');
}

export function testsReviewOutputPath(projectRoot: string, featureId: number | string): string {
  return join(featureDir(projectRoot, featureId), 'tests-review-output.json');
}

// What the independent reviewer reads: the same keys as the main suite's
// `review-request.json` (`suiteBuild.ts`), so the same role reads it the same
// way — the candidate's digest, the files as they will be uploaded, the one
// capability the feature is — plus two the main suite has no equivalent of:
// where `knowledge.md` is, because the promise each scenario protects is
// written there rather than in a capability description, and the scenarios
// themselves as the server sealed them.
export interface TestsReviewRequest {
  candidate_digest: string;
  suite_file: SuiteArtifact;
  capabilities: unknown;
  knowledge_path: string;
  scenarios: TestsPacket['scenarios'];
  output_path: string;
}

export function writeTestsReviewRequest(
  projectRoot: string,
  featureId: number | string,
  request: TestsReviewRequest,
): TestsReviewRequest {
  const path = testsReviewRequestPath(projectRoot, featureId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

// The reviewer's answer, in the shape the main suite's review takes
// (`readBehavioralReview` in `suiteBuild.ts`): the candidate digest at the
// top level and the `bdd_quality_review` beside it. Whether the digest is the
// current candidate's is `put-tests`' question, not this reader's — a stale
// review is ignored out loud there, not refused here.
export interface TestsReviewOutput {
  candidate_digest: string;
  bdd_quality_review: Record<string, unknown>;
}

export function readTestsReviewOutput(projectRoot: string, featureId: number | string): TestsReviewOutput | null {
  const path = testsReviewOutputPath(projectRoot, featureId);
  if (!existsSync(path)) return null;

  let review: unknown;
  try {
    review = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message})`);
  }
  const record = review as Record<string, unknown> | null;
  if (!record || typeof record !== 'object' || typeof record.candidate_digest !== 'string') {
    throw new Error(`${path} must carry candidate_digest at the top level, copied from tests-review-request.json.`);
  }
  if (!record.bdd_quality_review || typeof record.bdd_quality_review !== 'object') {
    throw new Error(`${path} must contain a bdd_quality_review object.`);
  }
  return { candidate_digest: record.candidate_digest, bdd_quality_review: record.bdd_quality_review as Record<string, unknown> };
}
