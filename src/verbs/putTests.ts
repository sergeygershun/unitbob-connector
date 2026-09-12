import type { Config } from '../config.ts';
import { createHash } from 'node:crypto';
import {
  knowledgePath,
  parseFeatureId,
  readKnowledge,
  readTestsOutput,
  readTestsRequest,
  readTestsReviewOutput,
  testsReviewOutputPath,
} from '../files/features.ts';
import { suiteCandidateDigest } from '../files/suiteBuild.ts';
import { enterUrl } from '../links.ts';
import { runBddSuite, type TagFilter } from '../runner/bdd.ts';
import { boundReport } from '../runner/boundReport.ts';
import { scenarioTally } from '../runner/failureDigest.ts';
import { gitRevision } from '../runner/gitRevision.ts';
import { placeAdvice } from '../runner/placeAdvice.ts';
import { placeProblem } from '../runner/place.ts';
import { runnerEnvironmentPlaceProblem } from '../runner/placeEnvironment.ts';
import type { RunnerResult } from '../runner/types.ts';
import { outputTail } from '../runner/outputTail.ts';
import { Wire, type FeatureSuiteRecorded, type FeatureSuiteUpload, type RunResultItem } from '../wire.ts';

interface PutTestsDeps {
  runBehavioral: (projectRoot: string, runner: string, mainPath: string, filter?: TagFilter) => Promise<RunnerResult>;
  gitRevision: (projectRoot: string) => string;
  putFeatureSuite: (featureId: number, upload: FeatureSuiteUpload) => Promise<FeatureSuiteRecorded>;
  postRunsBatch: (runs: unknown[]) => Promise<{ results: RunResultItem[]; map_url: string }>;
  stdout: { write: (chunk: string) => unknown };
}

const OUTPUT_TAIL_CHARS = 2000;

// The digest of `knowledge.md` on disk against the one the request was written
// from — both named when they differ, so the reader sees which side moved.
export function assertKnowledgeUnchanged(projectRoot: string, featureId: number | string, expected: string): void {
  const got = createHash('sha256').update(readKnowledge(projectRoot, featureId)).digest('hex');
  if (got === expected) return;
  throw new Error(
    `${knowledgePath(projectRoot, featureId)}: knowledge.md on disk differs from what the server has — ` +
      `run put-knowledge first, or restore the file, then run this again.\nexpected: ${expected}\n     got: ${got}`,
  );
}

// `put-tests <feature_id>` (spec 52-3, AC 3.5). The answer is read with its
// files from disk; the candidate digest is the one the review uses; then the
// connector runs the feature's tag itself — a report the host already has may
// be from earlier and over other files, and the proof has to be over these
// bytes. A runner that could not start or produced no report sends nothing:
// what it said is printed, and the exit code is non-zero. A 409 or 422 comes
// back as a WireError already worded by the server, one line per side, and is
// let through as it is.
//
// What the run proves decides what travels with it (spec 52-4, AC 1.10). All
// red: the run itself as `red_run`, revision and all, the way the known-defect
// probe sends its own. All green with the reviewer's file beside the answer:
// that file as `bdd_quality_review`, bound to this candidate. Anything else:
// no proof — the harness was saved mid-build. A review over a run that is not
// all green is not sent at all; a review of an older candidate is ignored out
// loud. And once the server has taken the version, the same run is filed
// under its digest, so the feature's page shows "N of M checks pass" on it at
// once rather than on the version before.
export async function putTests(config: Config, args: string[] = [], deps?: Partial<PutTestsDeps>): Promise<number> {
  const wire = new Wire(config);
  const d: PutTestsDeps = {
    runBehavioral: runBddSuite,
    gitRevision,
    putFeatureSuite: (id, upload) => wire.putFeatureSuite(id, upload),
    postRunsBatch: (runs) => wire.postRunsBatch(runs),
    stdout: process.stdout,
    ...deps,
  };

  const featureId = parseFeatureId(args[0], 'put-tests');
  const request = readTestsRequest(config.projectRoot, featureId);
  const output = readTestsOutput(config.projectRoot, featureId);
  // The same check `tests-prepare` made, made again here: the file may have
  // been edited in between, and the checks are sealed to the text the server
  // has, not to the text on disk (spec 52-3, edge cases).
  assertKnowledgeUnchanged(config.projectRoot, featureId, request.knowledge_digest);
  const unusable = placeProblem(config.projectRoot) ?? runnerEnvironmentPlaceProblem(config.projectRoot);
  if (unusable) throw new Error(unusable);

  // The review file, before the run: one the connector cannot read is a
  // stop, said in one line, and a run before it would be a run for nothing.
  const candidateDigest = suiteCandidateDigest({
    suite_kind: 'behavioral', suite_file: output.suite_file, runner_manifest: output.runner_manifest,
  });
  let review;
  try {
    review = readTestsReviewOutput(config.projectRoot, featureId);
  } catch (err) {
    d.stdout.write(`${(err as Error).message}\n`);
    d.stdout.write('Nothing was sent.\n');
    return 1;
  }
  if (review && review.candidate_digest !== candidateDigest) {
    d.stdout.write(`${testsReviewOutputPath(config.projectRoot, featureId)} is for an older candidate — ignored.\n`);
    review = null;
  }

  let result: RunnerResult;
  try {
    result = await d.runBehavioral(config.projectRoot, request.runner, request.feature_path, { only: request.feature_tag });
  } catch (err) {
    const advice = placeAdvice(config.projectRoot);
    d.stdout.write(`The runner could not start: ${(err as Error).message}\n${advice ? `\n${advice}\n` : ''}`);
    d.stdout.write('Nothing was sent.\n');
    return 1;
  }
  const report = boundReport(request.runner, result);
  if (report === null) {
    d.stdout.write(
      `The run produced no machine-readable report at ${result.resultPath} (exit code ${result.code}) — ` +
        'it died before the first scenario rather than failing them.\n',
    );
    const tail = outputTail(result, OUTPUT_TAIL_CHARS);
    if (tail) d.stdout.write(`${tail}\n`);
    d.stdout.write('Nothing was sent.\n');
    return 1;
  }

  const tally = scenarioTally(request.runner, result.report);
  const allRed = tally !== null && tally.passed === 0 && tally.failed > 0;
  const allGreen = tally !== null && tally.failed === 0 && tally.passed > 0;
  if (review && !allGreen) {
    d.stdout.write(`Review the checks when they all pass — ${stillFailing(tally)}.\n`);
    return 1;
  }

  const proof = review
    ? { bdd_quality_review: { ...review.bdd_quality_review, candidate_digest: candidateDigest } }
    : allRed
      ? { red_run: { candidate_digest: candidateDigest, revision: d.gitRevision(config.projectRoot), run_result: report } }
      : {};
  const recorded = await d.putFeatureSuite(featureId, {
    suite_file: output.suite_file,
    runner_manifest: output.runner_manifest,
    test_metadata: { ...output.test_metadata, ...proof },
    knowledge_digest: request.knowledge_digest,
  });
  // Said before the run is filed: the upload is done whatever happens next,
  // and a filing that fails leaves the run to the next `check`.
  d.stdout.write(`${recorded.message}\n`);

  const { results } = await d.postRunsBatch([{ suite_digest: recorded.suite_digest, run_result: report }]);
  for (const item of results) d.stdout.write(`${item.summary}\n`);
  d.stdout.write(`${enterUrl(config, recorded.url)}\n`);
  return 0;
}

// "2 of 5 still fail" — or, for a report the connector could not count, only
// that it could not.
function stillFailing(tally: { passed: number; failed: number } | null): string {
  if (tally === null) return 'the run’s report could not be read scenario by scenario';
  return `${tally.failed} of ${tally.passed + tally.failed} still fail`;
}

