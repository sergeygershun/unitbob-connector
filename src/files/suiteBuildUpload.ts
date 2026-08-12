import type { Config } from '../config.ts';
import { readBehavioralReview, type HostBranchOutput, type SuiteBuildRequest } from './suiteBuild.ts';
import type { SuiteBuildItem } from '../wire.ts';

// What travels to the server, and what "published" means when it answers. One
// module, because two commands ask those questions: `put-suite-build` sends the
// batch, and `validate-build` sends the same batch as a dry run so the server's
// verdict is about the exact bytes the publish will carry (spec 42, §3).
//
// A second assembly would be a second answer to "what are we uploading", and the
// dry run would then be checking something the publish does not send — which is
// worth less than not checking at all, because it reads as a verdict.

// The three outcomes that leave a branch published and current: a new version, an
// identical version already stored, or a reactivated one. Each returns the
// identity to run. Everything else — a rejected branch, a branch the host could
// not build, or a status this connector has never seen — fails closed and is
// never run, so a newer server can never trick an older connector into running
// something it does not understand.
export const PUBLISHED = new Set(['created', 'unchanged', 'restored']);

// The answer a dry run gives to a branch it would accept. A server that does not
// know `dry_run` answers one of `PUBLISHED` instead — which means it published —
// and `validate-build` says so rather than reporting a check that passed.
export const WOULD_PUBLISH = 'would_publish';

// One branch, as the upload sends it. `source_digest` comes from the request,
// never from the host's answer, so the host cannot claim a different map than
// the branch was given.
export function uploadItem(
  request: SuiteBuildRequest,
  output: HostBranchOutput,
  testMetadata: unknown,
): SuiteBuildItem {
  const sourceDigest = request.branches.find((branch) => branch.suite_kind === output.suite_kind)?.source_digest ?? '';
  if (output.build_error) {
    return { suite_kind: output.suite_kind, source_digest: sourceDigest, build_error: output.build_error };
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
}

// The behavioral branch's uploaded metadata, with the independent review and the
// connector's own run evidence folded in.
//
// Throws for anything that leaves this branch unpublishable — a missing review,
// one bound to a different candidate, a defect the review called not_supplied.
// The caller turns that into one unpublished branch rather than a failed
// command: a blocked review is a fact about the behavioral suite, and the
// structural peer next to it is finished and correct. Sinking the whole upload
// with it forced the one workaround this contract exists to prevent — hand-editing
// the answer down to a single branch, which loses the peer candidate for real.
export function withReview(config: Config, request: SuiteBuildRequest, output: HostBranchOutput): unknown {
  const review = readBehavioralReview(config.projectRoot, output);
  const probe = review.known_defect_probe as Record<string, unknown> | null;
  const qualityReview = review.bdd_quality_review as Record<string, unknown> | null;
  if (!qualityReview || typeof qualityReview !== 'object') {
    throw new Error('The separate behavioral review must contain a bdd_quality_review object.');
  }
  if (request.known_defect_context.status === 'supplied' && probe?.status === 'not_supplied') {
    throw new Error('A known defect was supplied to suite-prepare, but the behavioral review marked it not_supplied.');
  }
  return {
    ...(output.test_metadata as Record<string, unknown>),
    bdd_quality_review: {
      ...qualityReview,
      candidate_digest: review.candidate_digest,
    },
    ...(review.selection_review ? { selection_review: review.selection_review } : {}),
    known_defect_probe: review.known_defect_probe,
    known_defect_context: request.known_defect_context,
    candidate_run: review.candidate_run,
    ...(review.fixed_candidate_run ? { fixed_candidate_run: review.fixed_candidate_run } : {}),
  };
}
