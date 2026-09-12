import type { Config } from '../config.ts';
import {
  knowledgePath,
  parseFeatureId,
  readTestsOutput,
  readTestsRequest,
  testsReviewOutputPath,
  testsReviewRequestPath,
  writeTestsReviewRequest,
} from '../files/features.ts';
import { suiteCandidateDigest } from '../files/suiteBuild.ts';
import { Wire, type TestsPacket } from '../wire.ts';

interface TestsReviewPrepareDeps {
  getTestsPacket: (featureId: number) => Promise<TestsPacket>;
  stdout: { write: (chunk: string) => unknown };
}

// `tests-review-prepare <feature_id>` (spec 52-4, AC 1.11): the independent
// reviewer's task for a feature's checks, once they all pass. The packet
// first — a 409 is the server's own sentence, at `intent` (nothing to review)
// and at `done` (the checks are guardrails now), let through as it is — then
// the files from disk exactly as `put-tests` will send them, bound by the same
// candidate digest the upload carries, and the request written in the shape
// of the main suite's `review-request.json` so the same role reads it: plus
// where `knowledge.md` is, because the promise each scenario protects is
// written there, and the scenarios as the server sealed them. No model is
// called, nothing is uploaded; `put-tests` publishes the review.
export async function testsReviewPrepare(
  config: Config,
  args: string[] = [],
  deps?: Partial<TestsReviewPrepareDeps>,
): Promise<void> {
  const d: TestsReviewPrepareDeps = {
    getTestsPacket: (id) => new Wire(config).getTestsPacket(id),
    stdout: process.stdout,
    ...deps,
  };

  const featureId = parseFeatureId(args[0], 'tests-review-prepare');
  // An existence guard only: the request is what `put-tests` will read after
  // the review, and its absence names the verb that writes it — better said
  // here than as a missing answer two steps later.
  readTestsRequest(config.projectRoot, featureId);
  const packet = await d.getTestsPacket(featureId);
  const output = readTestsOutput(config.projectRoot, featureId);

  writeTestsReviewRequest(config.projectRoot, featureId, {
    candidate_digest: suiteCandidateDigest({
      suite_kind: 'behavioral', suite_file: output.suite_file, runner_manifest: output.runner_manifest,
    }),
    suite_file: output.suite_file,
    capabilities: output.test_metadata.capabilities,
    knowledge_path: knowledgePath(config.projectRoot, featureId),
    scenarios: packet.scenarios,
    output_path: testsReviewOutputPath(config.projectRoot, featureId),
  });
  d.stdout.write(`Feature review request written to ${testsReviewRequestPath(config.projectRoot, featureId)}\n`);
  d.stdout.write(
    `Next: have the independent reviewer write bdd_quality_review to ${testsReviewOutputPath(config.projectRoot, featureId)}, ` +
      `then run \`unitbob put-tests ${featureId}\`.\n`,
  );
}
