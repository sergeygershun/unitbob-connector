import type { Config } from '../config.ts';
import {
  readBehavioralReview,
  readHostSuiteOutputs,
  readSuiteBuildRequest,
  type SuiteBuildBranch,
} from '../files/suiteBuild.ts';
import { Wire, type SuiteBuildItem, type SuiteBuildResult } from '../wire.ts';

interface PutSuiteBuildDeps {
  putSuiteBuilds: (items: SuiteBuildItem[]) => Promise<SuiteBuildResult[]>;
  stdout: { write: (chunk: string) => unknown };
}

// Read the task and the host's answers, verify each branch parses and carries a
// safe-path artifact envelope, then upload both peer branches in one batch
// (spec 32). `source_digest` comes from the task — never the host's answer — so
// the host cannot claim a different map than each branch was given. A branch the
// host could not build is uploaded as a `build_error`, which never rolls back the
// peer branch. If a branch's answer is unparseable, nothing is uploaded.
export async function putSuiteBuild(config: Config, _args: string[] = [], deps?: Partial<PutSuiteBuildDeps>): Promise<void> {
  const request = readSuiteBuildRequest(config.projectRoot);
  const outputs = readHostSuiteOutputs(request.output_path, request);
  const d: PutSuiteBuildDeps = {
    putSuiteBuilds: (items) => new Wire(config).putSuiteBuilds(items),
    stdout: process.stdout,
    ...deps,
  };

  const digestFor = new Map(request.branches.map((branch) => [branch.suite_kind, branch.source_digest]));

  const items: SuiteBuildItem[] = outputs.map((output) => {
    const sourceDigest = digestFor.get(output.suite_kind) ?? '';
    if (output.build_error) {
      return { suite_kind: output.suite_kind, source_digest: sourceDigest, build_error: output.build_error };
    }
    let testMetadata = output.test_metadata;
    if (output.suite_kind === 'behavioral') {
      const review = readBehavioralReview(config.projectRoot, output);
      const probe = review.known_defect_probe as Record<string, unknown> | null;
      const qualityReview = review.bdd_quality_review as Record<string, unknown> | null;
      if (!qualityReview || typeof qualityReview !== 'object') {
        throw new Error('The separate behavioral review must contain a bdd_quality_review object.');
      }
      if (request.known_defect_context.status === 'supplied' && probe?.status === 'not_supplied') {
        throw new Error('A known defect was supplied to suite-prepare, but the behavioral review marked it not_supplied.');
      }
      testMetadata = {
        ...(output.test_metadata as Record<string, unknown>),
        bdd_quality_review: {
          ...qualityReview,
          candidate_digest: review.candidate_digest,
        },
        known_defect_probe: review.known_defect_probe,
        known_defect_context: request.known_defect_context,
        candidate_run: review.candidate_run,
        ...(review.fixed_candidate_run ? { fixed_candidate_run: review.fixed_candidate_run } : {}),
      };
    }
    return {
      suite_kind: output.suite_kind,
      source_digest: sourceDigest,
      artifacts: {
        suite_file: output.suite_file,
        runner_manifest: output.runner_manifest,
        test_metadata: testMetadata,
      },
    };
  });

  const results = await d.putSuiteBuilds(items);
  for (const result of results) {
    d.stdout.write(`${printResult(result)}\n`);
  }
}

function printResult(result: SuiteBuildResult): string {
  if (result.status === 'error' || result.status === 'build_error') {
    return `${result.suite_kind}: not published — ${result.error ?? 'the host could not build this suite'}.`;
  }
  const tallies = result.counts
    ? Object.entries(result.counts)
        .map(([name, value]) => `${value} ${name}`)
        .join(', ')
    : '';
  const digest = result.suite_digest ? ` (${result.suite_digest})` : '';
  return `${result.suite_kind}: ${result.status}${digest}${tallies ? ` — ${tallies}` : ''}.`;
}

// Re-exported for tests that construct branches directly.
export type { SuiteBuildBranch };
