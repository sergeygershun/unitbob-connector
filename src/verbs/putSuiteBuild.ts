import type { Config } from '../config.ts';
import {
  readBehavioralReview,
  readHostSuiteOutputsPerBranch,
  readSuiteBuildRequest,
  type HostBranchOutput,
  type SuiteBuildBranch,
  type SuiteBuildRequest,
} from '../files/suiteBuild.ts';
import { collectBuildProblems, formatBranchProblems } from './validateBuild.ts';
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
// peer branch. A branch whose local review will not bind is reported unpublished
// and its peer still goes up — one branch's problem is never the other's.
//
// The line between "skip this branch" and "upload nothing" is whose problem it
// is. The answer *file* is the whole answer: missing, unparseable, or carrying
// no branches array, it stops everything, because there is no second problem to
// find. Everything smaller belongs to one branch — a malformed entry, a review
// that will not bind, a marker the local check could not account for — and its
// peer still goes up.
//
// Returns the server's per-branch results so the caller can compose the first run
// on top of them (spec 32-4) without parsing the lines printed here.
export async function putSuiteBuild(
  config: Config,
  _args: string[] = [],
  deps?: Partial<PutSuiteBuildDeps>,
): Promise<SuiteBuildResult[]> {
  const request = readSuiteBuildRequest(config.projectRoot);
  // Spec 32-6: read branch by branch, so one unreadable entry neither hides the
  // next branch's problems nor sinks a peer that is finished and correct.
  const { outputs, unreadable } = readHostSuiteOutputsPerBranch(request.output_path, request);
  const d: PutSuiteBuildDeps = {
    putSuiteBuilds: (items) => new Wire(config).putSuiteBuilds(items),
    stdout: process.stdout,
    ...deps,
  };

  const digestFor = new Map(request.branches.map((branch) => [branch.suite_kind, branch.source_digest]));

  const items: SuiteBuildItem[] = [];
  const blocked: SuiteBuildResult[] = unreadable.map((entry) => ({
    suite_kind: entry.suite_kind,
    status: BLOCKED_STATUS,
    error: entry.message,
  }));

  // The same check `unitbob validate-build` runs, run here too so it cannot be
  // skipped by going straight to the upload — but reported the way every other
  // local failure here is reported: against the branch it belongs to.
  //
  // An earlier draft threw and stopped the command, which quietly undid spec
  // 32-5 Phase 4: one missing marker in the behavioral answer would have left a
  // finished structural suite unpublished. Every problem this check raises is
  // already named against a branch, so it blocks that branch and never the
  // batch. That also bounds what a false positive in a local check can cost —
  // one branch, with the peer still going up and the server still the authority.
  const problemsFor = new Map<string, string[]>();
  for (const problem of collectBuildProblems(request, outputs, unreadable)) {
    problemsFor.set(problem.branch, [...(problemsFor.get(problem.branch) ?? []), problem.message]);
  }

  for (const output of outputs) {
    const failed = problemsFor.get(output.suite_kind);
    problemsFor.delete(output.suite_kind);
    if (failed) {
      blocked.push({ suite_kind: output.suite_kind, status: BLOCKED_STATUS, error: formatBranchProblems(failed) });
      continue;
    }

    const sourceDigest = digestFor.get(output.suite_kind) ?? '';
    if (output.build_error) {
      items.push({ suite_kind: output.suite_kind, source_digest: sourceDigest, build_error: output.build_error });
      continue;
    }
    let testMetadata = output.test_metadata;
    if (output.suite_kind === 'behavioral') {
      try {
        testMetadata = withReview(config, request, output);
      } catch (err) {
        blocked.push({ suite_kind: output.suite_kind, status: BLOCKED_STATUS, error: (err as Error).message });
        continue;
      }
    }
    items.push({
      suite_kind: output.suite_kind,
      source_digest: sourceDigest,
      artifacts: {
        suite_file: output.suite_file,
        runner_manifest: output.runner_manifest,
        test_metadata: testMetadata,
      },
    });
  }

  // What is left in `problemsFor` belongs to a branch the loop above never
  // reached, because the answer has no entry for it at all. It has nothing to
  // upload and nothing to roll back, so it costs its peer nothing — but it is
  // exactly the branch that used to leave no trace anywhere, and the one line it
  // prints here is the whole point of noticing it (spec 32-6, a2time 2026-08-04).
  for (const [suiteKind, messages] of problemsFor) {
    blocked.push({ suite_kind: suiteKind, status: BLOCKED_STATUS, error: formatBranchProblems(messages) });
  }

  // Every branch is blocked, so there is nothing to upload. Asking the server to
  // publish an empty batch would turn a local, already-explained problem into a
  // wire error with a worse message.
  const results = items.length > 0 ? await d.putSuiteBuilds(items) : [];
  const all = [...results, ...blocked];
  for (const result of all) {
    d.stdout.write(`${printResult(result)}\n`);
  }
  return all;
}

// A branch that cannot be assembled locally: its review is missing, stale, or
// malformed. Not a server status — it never reaches the server — but it travels
// as one so a single rule decides what counts as published (see `PUBLISHED`).
const BLOCKED_STATUS = 'not_ready';

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
function withReview(config: Config, request: SuiteBuildRequest, output: HostBranchOutput): unknown {
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
    known_defect_probe: review.known_defect_probe,
    known_defect_context: request.known_defect_context,
    candidate_run: review.candidate_run,
    ...(review.fixed_candidate_run ? { fixed_candidate_run: review.fixed_candidate_run } : {}),
  };
}

// The three outcomes that leave a branch published and current: a new version, an
// identical version already stored, or a reactivated one. Each returns the
// identity to run. Everything else — a rejected branch, a branch the host could
// not build, or a status this connector has never seen — fails closed and is
// never run, so a newer server can never trick an older connector into running
// something it does not understand.
const PUBLISHED = new Set(['created', 'unchanged', 'restored']);

// Both halves of the answer come from one pass, because both are the same rule
// read in opposite directions: `digests` is what the first run may execute, and
// `unpublished` is what no result may ever be claimed about. Split across two
// functions they would eventually disagree, and a branch could be both skipped by
// the run and reported as if it had one.
export interface PublicationSplit {
  digests: string[];
  unpublished: string[];
}

export function classifyPublication(results: SuiteBuildResult[]): PublicationSplit {
  const split: PublicationSplit = { digests: [], unpublished: [] };

  for (const result of results) {
    if (!PUBLISHED.has(result.status)) {
      split.unpublished.push(result.suite_kind);
      continue;
    }
    if (!result.suite_digest) {
      throw new Error(
        `The server accepted the ${result.suite_kind} suite as "${result.status}" but returned no identity ` +
          'to run it by. The suite is published; run the Unitbob checks to finish.',
      );
    }
    split.digests.push(result.suite_digest);
  }

  return split;
}

// Asks `PUBLISHED` rather than naming the failing statuses again: this line and
// the run that follows it must agree about what "published" means, or a branch the
// command skipped gets a line that reads like a success — digest and all — right
// above "no suite was published".
function printResult(result: SuiteBuildResult): string {
  if (!PUBLISHED.has(result.status)) {
    // The reason often ends in a sentence of its own — a server message, or a
    // list of this branch's problems — so the closing stop is added only when
    // there is not one already.
    const reason = unpublishedReason(result);
    return `${result.suite_kind}: not published — ${reason}${/[.!?]$/.test(reason.trim()) ? '' : '.'}`;
  }
  const tallies = result.counts
    ? Object.entries(result.counts)
        .map(([name, value]) => `${value} ${name}`)
        .join(', ')
    : '';
  const digest = result.suite_digest ? ` (${result.suite_digest})` : '';
  return `${result.suite_kind}: ${result.status}${digest}${tallies ? ` — ${tallies}` : ''}.`;
}

// The server's own words when it sent any; otherwise the best true thing that can
// be said. A status this connector does not know is quoted rather than guessed
// at — claiming the host could not build it would invent a cause.
function unpublishedReason(result: SuiteBuildResult): string {
  if (result.error) return result.error;
  if (result.status === 'build_error') return 'the host could not build this suite';

  return `the server answered "${result.status}"`;
}

// Re-exported for tests that construct branches directly.
export type { SuiteBuildBranch };
