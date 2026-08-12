import type { Config } from '../config.ts';
import { existsSync } from 'node:fs';
import {
  readHostSuiteOutputsPerBranch,
  readSuiteBuildRequest,
  reviewOutputPath,
  type HostBranchOutput,
  type SuiteBuildRequest,
  type UnreadableBranch,
} from '../files/suiteBuild.ts';
import { PUBLISHED, uploadItem, withReview, WOULD_PUBLISH } from '../files/suiteBuildUpload.ts';
import { Wire, WireError, type SuiteBuildItem, type SuiteBuildResult } from '../wire.ts';

// Spec 42. This file used to predict the server's verdict. It now asks for it.
//
// The prediction was a copy of the server's rules — which ids are answered and
// how, markers, surface arithmetic, the runner manifest, the surface ceiling —
// and a copy of a rule cannot help drifting from it. It drifted: on 2026-08-12
// this check passed four answers out of six that the server then refused, and
// one refusal came from the drift itself. Its marker check concatenated the main
// file with every support file while the server read only the main file, so a
// suite the server would reject was declared well-formed, and an a2time run
// found out fifty minutes later.
//
// Spec 32-6 chose the copy deliberately, to move the feedback loop from an hour
// to seconds. That goal was right and is kept; only the means change. The server
// now has a check that publishes nothing (`dry_run`), so the same feedback
// arrives in seconds from the one implementation that decides. ADR 0001 asks a
// pre-check either to run the same thing it predicts or to say what it did not
// cover — asking is the first of those, exactly.
//
// What stays here is what the server cannot see, because it has neither the
// files nor the request: whether the files the answer names exist and sit inside
// `.unitbob/`, and whether the answer covers the branches the request asked for.
export interface BuildProblem {
  branch: string;
  message: string;
}

// The three things a dry run does not do. The list is closed and none of them
// can reject an artifact: deduplication needs to know whether this digest is
// already stored, `make_current!` moves the pointer, `parent_digest` records
// lineage. ADR 0001 asks for them to be named out loud, and one fixed line is
// how — a field in the protocol that always carries the same sentence tells a
// reader nothing and stays in the shape for ever.
const DRY_RUN_DOES_NOT =
  'A dry run skips exactly three things the publish does: deduplication by digest, moving the current ' +
  'pointer, and recording the parent digest. None of the three can reject an artifact.';

export function collectBuildProblems(
  request: SuiteBuildRequest,
  outputs: HostBranchOutput[],
  unreadable: UnreadableBranch[] = [],
): BuildProblem[] {
  return unansweredBranches(request, outputs, unreadable);
}

// The branch that is not there at all. Reading the answer tells you whether what
// arrived is well-formed; it cannot see a branch the answer never mentions,
// because there is no entry to walk. So this walks the request instead — the
// only list that knows what was asked for.
//
// The a2time run of 2026-08-04 is the whole reason. Its behavioral branch was
// prepared, half-built and abandoned for budget; the answer went up carrying the
// structural branch alone; this check said "well-formed"; the upload published
// one branch and said nothing about the other. Nothing anywhere recorded that a
// second branch had ever been asked for, so the cost of the work already done on
// it was not merely wasted, it was invisible.
//
// The server cannot close this gap: it checks each branch it receives, and this
// is about a branch nobody sent it.
//
// `build_error` is the answer for a branch that could not be built, and it is
// deliberately cheap to give — one line, no suite, never blocks the peer. This
// does not demand the branch be built. It demands only that its absence be
// stated rather than left as a silence that reads like success.
//
// A branch whose entry existed but could not be parsed is already reported as
// unreadable by the caller; naming it "missing" too would be two complaints
// about one mistake, and the second would send the reader looking for a second
// problem that is not there.
function unansweredBranches(
  request: SuiteBuildRequest,
  outputs: HostBranchOutput[],
  unreadable: UnreadableBranch[],
): BuildProblem[] {
  const accounted = new Set<string>([
    ...outputs.map((output) => output.suite_kind),
    ...unreadable.map((entry) => entry.suite_kind),
  ]);

  return request.branches
    .filter((branch) => !accounted.has(branch.suite_kind))
    .map((branch) => ({
      branch: branch.suite_kind,
      message:
        'the request asked for this branch and the answer has no entry for it — it is neither built nor ' +
        'declared unbuildable. Every branch in the request gets one entry: the suite you built, or ' +
        `{ "suite_kind": "${branch.suite_kind}", "build_error": { "message": "why not" } }. ` +
        'Leaving it out is not the same as declining it: nothing records that this branch was ever asked ' +
        'for, so the work already spent on it disappears without a trace.',
    }));
}

// Reads the task and the answer and reports every local problem it can see.
// Reading the answer is itself a check — safe paths, files that exist, a
// parseable envelope — and it is done branch by branch, so a bad entry in one
// contributes its problem and the other is still examined.
export function validateBuildProblems(config: Config): BuildProblem[] {
  const request = readSuiteBuildRequest(config.projectRoot);
  const { outputs, unreadable } = readHostSuiteOutputsPerBranch(request.output_path, request);

  return [
    ...unreadable.map((entry) => ({ branch: entry.suite_kind, message: entry.message })),
    ...collectBuildProblems(request, outputs, unreadable),
  ];
}

// One report, not a queue of one-at-a-time discoveries. Fixing one thing to be
// told the next costs a full round trip each time, and the round trip is the
// expensive part.
export function formatProblems(problems: BuildProblem[]): string {
  const lines = problems.map((problem) => `  ${problem.branch}: ${problem.message}`);
  return (
    `Your suite answer has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n` +
    `${lines.join('\n')}\n` +
    'Fix all of them, then answer again. These are the checks the server cannot make — it has ' +
    'neither your files nor the request it issued.\n'
  );
}

interface ValidateBuildDeps {
  dryRun: (items: SuiteBuildItem[]) => Promise<SuiteBuildResult[]>;
  stdout: { write: (chunk: string) => unknown };
}

// The exact batch `put-suite-build` would send, plus the two things that can go
// wrong on the way there.
//
// `validate-build` runs before the run and before the review, so the behavioral
// review usually does not exist yet. That is not a fault in the answer — it is a
// question this check cannot ask yet — so the branch still goes to the server
// without it and the gap is named out loud (ADR 0001).
//
// A review that *does* exist and will not bind is the opposite: a review of a
// different candidate, a missing `bdd_quality_review`, a `selection_review` that
// does not match the plan. `put-suite-build` refuses the branch for each of
// those, so calling any of them "not written yet" would hand back a green
// verdict for a branch that is about to be blocked — and the second run of this
// command, the one after the review, is precisely where that must not happen.
function dryRunBatch(
  config: Config,
  request: SuiteBuildRequest,
  outputs: HostBranchOutput[],
): { items: SuiteBuildItem[]; unchecked: string[]; problems: BuildProblem[] } {
  const items: SuiteBuildItem[] = [];
  const unchecked: string[] = [];
  const problems: BuildProblem[] = [];

  for (const output of outputs) {
    if (output.build_error) {
      items.push(uploadItem(request, output, undefined));
      continue;
    }

    let testMetadata = output.test_metadata;
    if (output.suite_kind === 'behavioral') {
      try {
        testMetadata = withReview(config, request, output);
      } catch (error) {
        if (existsSync(reviewOutputPath(config.projectRoot))) {
          problems.push({ branch: output.suite_kind, message: (error as Error).message });
          continue;
        }
        unchecked.push(
          `${output.suite_kind}: the independent review has not been written yet, so the server judged ` +
            'this branch without it. Anything it says about bdd_quality_review, known_defect_probe or ' +
            'candidate_run is answered later, by `suite-review-prepare` and the reviewer — run this ' +
            'command again afterwards for a verdict on the whole branch.',
        );
      }
    }
    items.push(uploadItem(request, output, testMetadata));
  }

  return { items, unchecked, problems };
}

function describe(result: SuiteBuildResult): string {
  const tallies = result.counts
    ? Object.entries(result.counts)
        .map(([name, value]) => `${value} ${name}`)
        .join(', ')
    : '';
  return `  ${result.suite_kind}: ${result.status}${tallies ? ` — ${tallies}` : ''}`;
}

// The server's own words, never a paraphrase. Rewording a rejection here is how
// a third implementation of a rule starts: the reader then acts on this file's
// idea of what the server meant, and the two drift the moment either changes.
function rejection(result: SuiteBuildResult): string {
  return `  ${result.suite_kind}: ${result.error ?? `the server answered "${result.status}"`}`;
}

export async function validateBuild(
  config: Config,
  _args: string[] = [],
  deps?: Partial<ValidateBuildDeps>,
): Promise<void> {
  const d: ValidateBuildDeps = {
    dryRun: (items) => new Wire(config).putSuiteBuilds(items, { dryRun: true }),
    stdout: process.stdout,
    ...deps,
  };

  const request = readSuiteBuildRequest(config.projectRoot);
  const { outputs, unreadable } = readHostSuiteOutputsPerBranch(request.output_path, request);
  const { items, unchecked, problems } = dryRunBatch(config, request, outputs);

  const local = [
    ...unreadable.map((entry) => ({ branch: entry.suite_kind, message: entry.message })),
    ...collectBuildProblems(request, outputs, unreadable),
    ...problems,
  ];
  if (local.length > 0) throw new Error(formatProblems(local));

  for (const line of unchecked) d.stdout.write(`Not checked — ${line}\n`);

  if (items.length === 0) {
    d.stdout.write('There is nothing to check with the server: the answer builds no branch.\n');
    return;
  }

  let results: SuiteBuildResult[];
  try {
    results = await d.dryRun(items);
  } catch (error) {
    if (error instanceof WireError && error.unreachable) {
      d.stdout.write(
        `The Unitbob server was not asked for a verdict: ${error.message}\n` +
          'Unchecked, therefore: how the assignment was answered, case markers, surface arithmetic and the ' +
          'surface ceiling, the runner manifest, and the review binding — every rule the server owns. What ' +
          'passed here is only that the files exist, sit under .unitbob/, and that every branch the request ' +
          'asked for has an entry.\n',
      );
      return;
    }
    throw error;
  }

  // A server older than `dry_run` ignores the flag and publishes. Saying "the
  // check passed" then would be the worst possible answer: the suite is live and
  // the one publication the recipe allows has been spent.
  const published = results.filter((result) => PUBLISHED.has(result.status));
  if (published.length > 0) {
    throw new Error(
      `This Unitbob server does not know dry runs: it published ${published.map((r) => r.suite_kind).join(', ')} ` +
        'instead of checking. Upgrade the server before running validate-build again — and note that this ' +
        'branch is now live.\n',
    );
  }

  const refused = results.filter((result) => result.status !== WOULD_PUBLISH && result.status !== 'build_error');
  if (refused.length > 0) {
    throw new Error(
      `The Unitbob server would refuse this answer:\n${refused.map(rejection).join('\n')}\n` +
        'Those are the server\'s own words. Fix them, then run `unitbob validate-build` again — this round ' +
        'costs one request, not another run and review.\n',
    );
  }

  // "Would publish it" is only true of the branches it would actually publish. An
  // answer whose every branch is a declared `build_error` is accepted and stores
  // nothing, and reporting that as a suite about to go up would be the one
  // sentence in this output that is not true of what happened.
  const accepted = results.filter((result) => result.status === WOULD_PUBLISH);
  const headline = accepted.length === 0
    ? 'The Unitbob server accepted this answer, and it publishes no suite:'
    : 'The Unitbob server checked this answer and would publish it:';

  d.stdout.write(`${headline}\n${results.map(describe).join('\n')}\n${DRY_RUN_DOES_NOT}\n`);
}
