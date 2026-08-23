import type { Config } from '../config.ts';
import {
  readHostSuiteOutputsPerBranch,
  readSuiteBuildRequest,
  type SuiteBuildBranch,
} from '../files/suiteBuild.ts';
import { placeProblem } from '../runner/place.ts';
import { collectBuildProblems } from './validateBuild.ts';
import { PUBLISHED, uploadItem, withReview } from '../files/suiteBuildUpload.ts';
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
  // Spec 36, criterion 7. Publishing is followed immediately by a first run, so
  // a place that cannot be used is not something to discover after the suite is
  // stored on the server.
  const unusable = placeProblem(config.projectRoot);
  if (unusable) throw new Error(`${unusable}\nNothing was uploaded.`);

  const request = readSuiteBuildRequest(config.projectRoot);
  // Spec 32-6: read branch by branch, so one unreadable entry neither hides the
  // next branch's problems nor sinks a peer that is finished and correct.
  const { outputs, unreadable } = readHostSuiteOutputsPerBranch(request.output_path, request);
  const d: PutSuiteBuildDeps = {
    putSuiteBuilds: (items) => new Wire(config).putSuiteBuilds(items),
    stdout: process.stdout,
    ...deps,
  };

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
  // Since spec one-place-per-rule that check is exactly one question, and it is about a branch
  // the answer has *no* entry for: everything else it used to ask is now asked
  // of the server, by a dry run, before this command runs at all. So its
  // problems can never land on a branch this loop visits, and they are reported
  // below rather than inside it.
  //
  // An earlier draft threw and stopped the command, which quietly undid spec
  // 32-5 Phase 4: one behavioral problem would have left a finished structural
  // suite unpublished. Every problem here is named against a branch, so it
  // blocks that branch and never the batch.
  for (const output of outputs) {
    if (output.build_error) {
      items.push(uploadItem(request, output, undefined));
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
    items.push(uploadItem(request, output, testMetadata));
  }

  // A branch the request asked for and the answer never mentions. It has nothing
  // to upload and nothing to roll back, so it costs its peer nothing — but it is
  // exactly the branch that used to leave no trace anywhere, and the one line it
  // prints here is the whole point of noticing it (spec 32-6, a2time 2026-08-04).
  for (const problem of collectBuildProblems(request, outputs, unreadable)) {
    blocked.push({ suite_kind: problem.branch, status: BLOCKED_STATUS, error: problem.message });
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
  return (
    `${result.suite_kind}: ${result.status}${digest}${tallies ? ` — ${tallies}` : ''}.` + printDowngrades(result)
  );
}

// Spec 43, §7. A capability every one of whose Scenarios the review objected to
// is stored `unguarded` by the publish. The run is standing right here when that
// is decided, so it is told here, in the server's own words — finding it on the
// map afterwards is how a run finishes believing it published a guarantee it did
// not.
function printDowngrades(result: SuiteBuildResult): string {
  const downgraded = result.unguarded_by_review ?? [];
  if (downgraded.length === 0) return '';

  return (
    `\n  ${downgraded.length} capability(ies) published unguarded, because the review objected to every ` +
    'Scenario guarding them:\n' +
    downgraded.map((entry) => `    - ${entry.capability_id}: ${entry.reason}`).join('\n')
  );
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
