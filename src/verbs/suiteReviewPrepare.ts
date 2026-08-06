import type { Config } from '../config.ts';
import { execFileSync } from 'node:child_process';
import type { ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  copyBehavioralRunnerEnvironment,
  filesLostOnMaterialize,
  materializeBehavioral,
} from '../files/behavioral.ts';
import { runBddSuite } from '../runner/bdd.ts';
import { boundReport } from '../runner/boundReport.ts';
import type { SuiteArtifact } from '../wire.ts';
import {
  branchRunner,
  readHostSuiteOutputs,
  readSuiteBuildRequest,
  reviewRequestPath,
  writeBehavioralReviewRequest,
} from '../files/suiteBuild.ts';
import type { HostBranchOutput } from '../files/suiteBuild.ts';
import { spend } from '../files/budget.ts';

interface SuiteReviewPrepareDeps {
  runCandidate: (
    projectRoot: string,
    output: HostBranchOutput,
    revision?: string,
  ) => Promise<{ revision: string; run_result: string }>;
  stdout: { write: (chunk: string) => unknown };
}

export async function suiteReviewPrepare(
  config: Config,
  _args: string[] = [],
  deps?: Partial<SuiteReviewPrepareDeps>,
): Promise<void> {
  const actual: SuiteReviewPrepareDeps = {
    runCandidate: runCandidate,
    stdout: process.stdout,
    ...deps,
  };
  const buildRequest = readSuiteBuildRequest(config.projectRoot);
  const behavioral = readHostSuiteOutputs(buildRequest.output_path, buildRequest)
    .find((branch) => branch.suite_kind === 'behavioral');

  if (!behavioral) throw new Error('The suite build has no behavioral candidate to review.');
  if (behavioral.build_error) {
    throw new Error(`The behavioral candidate could not be reviewed: ${behavioral.build_error.message}`);
  }

  // Say this before the run, not after: the run materializes the answer, and
  // that is where a forgotten file turns into undefined steps — by then it is
  // already gone.
  const lost = filesLostOnMaterialize(
    config.projectRoot,
    behavioral.suite_file as SuiteArtifact,
    branchRunner(behavioral),
  );
  if (lost.length > 0) {
    actual.stdout.write(
      `Warning: these files sit with the suite but are not in its answer, and running it will delete them: ${lost.join(', ')}.\n`,
    );
  }

  const candidateRun = await actual.runCandidate(config.projectRoot, behavioral);
  const fixedRevision = buildRequest.known_defect_context.status === 'supplied'
    ? buildRequest.known_defect_context.fixed_revision
    : undefined;
  const fixedCandidateRun = fixedRevision
    ? await actual.runCandidate(config.projectRoot, behavioral, fixedRevision)
    : undefined;

  const request = writeBehavioralReviewRequest(
    config.projectRoot,
    behavioral,
    candidateRun,
    buildRequest.known_defect_context,
    fixedCandidateRun,
  );
  actual.stdout.write(`Behavioral review request written to ${reviewRequestPath(config.projectRoot)}\n`);
  actual.stdout.write(
    `Next: have an independent reviewer inspect this exact candidate and write bdd_quality_review and known_defect_probe to ${request.output_path}, then run \`unitbob put-suite-build\`.\n`,
  );

  // Counted after the request is written, never before it. Refusing the round
  // would rebuild the autobrella deadlock on a different number: the branch
  // could not publish, so the work would be lost again for the sake of the
  // ceiling meant to protect it. What the ceiling buys is a sentence.
  const round = spend(config.projectRoot, 'review_rounds');
  const budget = buildRequest.budget;
  if (budget && round > budget.review_rounds) {
    actual.stdout.write(lastRoundNotice(round, budget.review_rounds));
  }
}

// Says what to do, not that something is forbidden. This is only sayable because
// spec 34-2 already made an imperfect suite publishable: before it, "publish what
// you have" was not available to the reviewer at all, and the only way to record
// a bad Scenario was to take the branch down.
function lastRoundNotice(round: number, allowed: number): string {
  return (
    `\nThis is review round ${round}; the budget for this build was ${allowed}. Treat it as the last round ` +
    'and publish what you have.\n' +
    'A Scenario the reviewer still objects to does not hold the branch back: it is recorded with ' +
    '`verdict: "does_not_pass"` and a `reviewer_objection_text` saying what is wrong, the branch publishes, ' +
    'and the objection is read afterwards by the operator. Another round of rewriting buys less than ' +
    'publishing the objection does.\n'
  );
}

async function runCandidate(
  projectRoot: string,
  output: HostBranchOutput,
  revision?: string,
): Promise<{ revision: string; run_result: string }> {
  if (revision) return runCandidateAtRevision(projectRoot, output, revision);
  return runCandidateInProject(projectRoot, output, gitRevision(projectRoot));
}

async function runCandidateInProject(
  projectRoot: string,
  output: HostBranchOutput,
  revision: string,
): Promise<{ revision: string; run_result: string }> {
  const runner = branchRunner(output);
  const suiteFile = output.suite_file as SuiteArtifact;
  const mainPath = materializeBehavioral(projectRoot, suiteFile, runner).mainPath;
  const result = await runBddSuite(projectRoot, runner, mainPath);
  const report = boundReport(runner, result);
  if (report === null) throw new Error('The behavioral candidate produced no machine-readable runner report.');
  return { revision, run_result: report };
}

async function runCandidateAtRevision(
  projectRoot: string,
  output: HostBranchOutput,
  revision: string,
): Promise<{ revision: string; run_result: string }> {
  const resolved = execFileSync('git', ['rev-parse', '--verify', revision], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();
  const worktree = mkdtempSync(join(tmpdir(), 'unitbob-fixed-review-'));
  let added = false;
  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktree, resolved], { cwd: projectRoot, stdio: 'pipe' });
    added = true;
    const runner = branchRunner(output);
    materializeBehavioral(worktree, output.suite_file as SuiteArtifact, runner);
    copyBehavioralRunnerEnvironment(projectRoot, worktree, runner);
    return await runCandidateInProject(worktree, output, revision);
  } finally {
    if (added) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: projectRoot, stdio: 'pipe' });
      } catch {
        // The temporary directory cleanup below is still safe and bounded.
      }
    }
    rmSync(worktree, { recursive: true, force: true });
    if (added) {
      try {
        // `remove` can fail while the directory still goes away just above,
        // which leaves a dangling entry under .git/worktrees in the user's own
        // checkout. Reviewing a suite must not litter the repository it reads.
        execFileSync('git', ['worktree', 'prune'], { cwd: projectRoot, stdio: 'pipe' });
      } catch {
        // Housekeeping only — never fail a finished review run over it.
      }
    }
  }
}

function gitRevision(projectRoot: string): string {
  try {
    const options: ExecFileSyncOptionsWithStringEncoding = {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    const head = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], options).trim();
    return dirty ? `${head}-dirty` : head;
  } catch {
    return 'working-tree';
  }
}
