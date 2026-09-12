import type { Config } from '../config.ts';
import { parseFeatureId, readTestsOutput, readTestsRequest } from '../files/features.ts';
import { suiteCandidateDigest } from '../files/suiteBuild.ts';
import { enterUrl } from '../links.ts';
import { runBddSuite, type TagFilter } from '../runner/bdd.ts';
import { boundReport } from '../runner/boundReport.ts';
import { gitRevision } from '../runner/gitRevision.ts';
import { placeAdvice } from '../runner/placeAdvice.ts';
import { placeProblem } from '../runner/place.ts';
import { runnerEnvironmentPlaceProblem } from '../runner/placeEnvironment.ts';
import type { RunnerResult } from '../runner/types.ts';
import { Wire, type FeatureSuiteRecorded, type FeatureSuiteUpload } from '../wire.ts';

interface PutTestsDeps {
  runBehavioral: (projectRoot: string, runner: string, mainPath: string, filter?: TagFilter) => Promise<RunnerResult>;
  gitRevision: (projectRoot: string) => string;
  putFeatureSuite: (featureId: number, upload: FeatureSuiteUpload) => Promise<FeatureSuiteRecorded>;
  stdout: { write: (chunk: string) => unknown };
}

const OUTPUT_TAIL_CHARS = 2000;

// `put-tests <feature_id>` (spec 52-3, AC 3.5). The answer is read with its
// files from disk; the candidate digest is the one the review uses; then the
// connector runs the feature's tag itself — a report the host already has may
// be from earlier and over other files, and the proof of red has to be over
// these bytes — and sends the run as `red_run`, revision and all, the way the
// known-defect probe sends its own. A runner that could not start or produced
// no report sends nothing: what it said is printed, and the exit code is
// non-zero. A 409 or 422 comes back as a WireError already worded by the
// server, one line per side, and is let through as it is.
export async function putTests(config: Config, args: string[] = [], deps?: Partial<PutTestsDeps>): Promise<number> {
  const d: PutTestsDeps = {
    runBehavioral: runBddSuite,
    gitRevision,
    putFeatureSuite: (id, upload) => new Wire(config).putFeatureSuite(id, upload),
    stdout: process.stdout,
    ...deps,
  };

  const featureId = parseFeatureId(args[0], 'put-tests');
  const request = readTestsRequest(config.projectRoot, featureId);
  const output = readTestsOutput(config.projectRoot, featureId);
  const unusable = placeProblem(config.projectRoot) ?? runnerEnvironmentPlaceProblem(config.projectRoot);
  if (unusable) throw new Error(unusable);

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
    const tail = outputTail(result);
    if (tail) d.stdout.write(`${tail}\n`);
    d.stdout.write('Nothing was sent.\n');
    return 1;
  }

  const candidateDigest = suiteCandidateDigest({
    suite_kind: 'behavioral', suite_file: output.suite_file, runner_manifest: output.runner_manifest,
  });
  const recorded = await d.putFeatureSuite(featureId, {
    suite_file: output.suite_file,
    runner_manifest: output.runner_manifest,
    test_metadata: {
      ...output.test_metadata,
      red_run: { candidate_digest: candidateDigest, revision: d.gitRevision(config.projectRoot), run_result: report },
    },
    knowledge_digest: request.knowledge_digest,
  });
  d.stdout.write(`${recorded.message}\n`);
  d.stdout.write(`${enterUrl(config, recorded.url)}\n`);
  return 0;
}

function outputTail(result: RunnerResult): string {
  const bits: string[] = [];
  if (result.stderr.trim()) bits.push(result.stderr.trim());
  if (result.stdout.trim()) bits.push(result.stdout.trim());
  const joined = bits.join('\n');
  return joined.length > OUTPUT_TAIL_CHARS ? joined.slice(-OUTPUT_TAIL_CHARS) : joined;
}
