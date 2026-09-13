import type { Config } from '../config.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changedFeatureFiles,
  copyBehavioralRunnerEnvironment,
  FeatureFilesChangedError,
  filesLostOnMaterialize,
  materializeBehavioralUnion,
} from '../files/behavioral.ts';
import { runBddSuite } from '../runner/bdd.ts';
import { boundReport } from '../runner/boundReport.ts';
import { placeOf } from '../runner/place.ts';
import { gitRevision } from '../runner/gitRevision.ts';
import { Wire, type FeatureSuiteItem, type RunnerManifestWire, type SuiteArtifact, type SuiteIndex } from '../wire.ts';
import {
  branchRunner,
  readHostSuiteOutputs,
  readSuiteBuildRequest,
  reviewRequestPath,
  writeBehavioralReviewRequest,
} from '../files/suiteBuild.ts';
import type { HostBranchOutput } from '../files/suiteBuild.ts';

interface SuiteReviewPrepareDeps {
  getSuiteIndex: () => Promise<SuiteIndex>;
  runCandidate: (
    projectRoot: string,
    output: HostBranchOutput,
    features: readonly FeatureSuiteItem[],
    revision?: string,
  ) => Promise<{ revision: string; run_result: string }>;
  stdout: { write: (chunk: string) => unknown };
}

// The candidate is run on disk as the same union `check` writes (spec 52-4,
// AC 1.8): the candidate plus the checks of every red feature the server
// holds, with their tags left out of the run. Written as the candidate alone,
// the review wiped those checks from the disk — and with them any steps the
// host had rewired against the real code and not yet saved.
export async function suiteReviewPrepare(
  config: Config,
  _args: string[] = [],
  deps?: Partial<SuiteReviewPrepareDeps>,
): Promise<void> {
  const actual: SuiteReviewPrepareDeps = {
    getSuiteIndex: () => new Wire(config).getSuiteIndex(),
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

  // Before anything else is said or run: a feature's checks rewired on disk
  // and not saved stop the review here, disk untouched, with the command that
  // saves them — the same stop `check` makes.
  const features = (await actual.getSuiteIndex()).feature_suites;
  const changed = changedFeatureFiles(config.projectRoot, features);
  if (changed.length > 0) throw new FeatureFilesChangedError(changed[0].feature_id, changed[0].title);

  // Say this before the run, not after: the run materializes the answer, and
  // that is where a forgotten file turns into undefined steps — by then it is
  // already gone.
  const lost = filesLostOnMaterialize(
    config.projectRoot,
    behavioral.suite_file as SuiteArtifact,
    branchRunner(behavioral),
    features.map((item) => item.suite_file),
  );
  if (lost.length > 0) {
    actual.stdout.write(
      `Warning: these files sit with the suite but are not in its answer, and running it will delete them: ${lost.join(', ')}.\n`,
    );
  }

  const candidateRun = await actual.runCandidate(config.projectRoot, behavioral, features);
  const fixedRevision = buildRequest.known_defect_context.status === 'supplied'
    ? buildRequest.known_defect_context.fixed_revision
    : undefined;
  const fixedCandidateRun = fixedRevision
    ? await actual.runCandidate(config.projectRoot, behavioral, features, fixedRevision)
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
}

async function runCandidate(
  projectRoot: string,
  output: HostBranchOutput,
  features: readonly FeatureSuiteItem[],
  revision?: string,
): Promise<{ revision: string; run_result: string }> {
  if (revision) return runCandidateAtRevision(projectRoot, output, features, revision);
  return runCandidateInProject(projectRoot, output, features, gitRevision(projectRoot));
}

async function runCandidateInProject(
  projectRoot: string,
  output: HostBranchOutput,
  features: readonly FeatureSuiteItem[],
  revision: string,
): Promise<{ revision: string; run_result: string }> {
  const runner = branchRunner(output);
  const { mainPath, excludeTags } = candidateUnion(projectRoot, output, features);
  const result = await runBddSuite(projectRoot, runner, mainPath, { exclude: excludeTags });
  const report = boundReport(runner, result);
  if (report === null) throw new Error('The behavioral candidate produced no machine-readable runner report.');
  return { revision, run_result: report };
}

// The candidate on disk as `check` would write it: the union of the candidate
// and every feature's checks, one clearing, the feature tags to leave out.
// Through `materializeBehavioralUnion` rather than beside it, so the stop on
// a changed feature file is the same one, made before the disk is touched.
export function candidateUnion(
  projectRoot: string,
  output: HostBranchOutput,
  features: readonly FeatureSuiteItem[],
): { mainPath: string; excludeTags: string[] } {
  const index: SuiteIndex = {
    suites: [{
      suite_kind: 'behavioral',
      status: 'ready',
      suite_file: output.suite_file as SuiteArtifact,
      runner_manifest: output.runner_manifest as RunnerManifestWire,
    }],
    feature_suites: [...features],
  };
  // Never null: the candidate itself is in the union.
  return materializeBehavioralUnion(projectRoot, index, branchRunner(output))!;
}

async function runCandidateAtRevision(
  projectRoot: string,
  output: HostBranchOutput,
  features: readonly FeatureSuiteItem[],
  revision: string,
): Promise<{ revision: string; run_result: string }> {
  // Spec 36, Non-Goals. The worktree below is created under the system's
  // temporary directory — outside anything a container has mounted, so in there
  // it does not exist at all. Said plainly rather than run into. The obvious
  // repair, moving the worktree under `.unitbob/`, puts a whole second copy of
  // the application inside the tree graphify scans, and a copy left behind by a
  // failure builds the next map out of two applications.
  const place = placeOf(projectRoot);
  if (place.kind === 'docker') {
    throw new Error(
      "Reviewing at a fixed revision is not supported while this project's tests run inside a container " +
        `(\`${place.container}\`): the review needs a git worktree outside the project, which the container ` +
        'cannot see. Review against the working tree instead (drop the fixed revision), or run this project ' +
        'on this machine.',
    );
  }

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
    candidateUnion(worktree, output, features);
    copyBehavioralRunnerEnvironment(projectRoot, worktree, runner);
    return await runCandidateInProject(worktree, output, features, revision);
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
