import type { Config } from '../config.ts';
import { materializeGuardrails } from '../files/guardrails.ts';
import { FeatureFilesChangedError, materializeBehavioralUnion } from '../files/behavioral.ts';
import { placeProblem } from '../runner/place.ts';
import { runnerEnvironmentPlaceProblem } from '../runner/placeEnvironment.ts';
import { validateStack, type PrecheckResult } from '../runner/precheck.ts';
import { runRspecSuite } from '../runner/rspec.ts';
import { runVitestSuite, testPathsOf } from '../runner/vitest.ts';
import { runPytestSuite } from '../runner/pytest.ts';
import { runBddSuite, type TagFilter } from '../runner/bdd.ts';
import type { RunnerResult } from '../runner/types.ts';
import { outputTail } from '../runner/outputTail.ts';
import { enterUrl } from '../links.ts';
import { boundReport } from '../runner/boundReport.ts';
import { Wire, type FeatureSuiteItem, type RunResultItem, type SuiteArtifact, type SuiteIndex, type SuiteListItem } from '../wire.ts';

const OUTPUT_TAIL_CHARS = 2000;

// The check flow, made peer-aware (spec 32). Fetch both peer suites in one batch,
// run each one that is `ready` with its own connector-owned runner, and ship both
// raw reports (or structured suite errors) in one batch. The connector interprets
// nothing — Rails owns the marker join, the status, the map, and the two
// summaries. Each branch is independent: one branch's runner error never stops the
// other, and the connector never installs a dependency here.
//
// Two entry points share all of that and differ only in which suites they select:
// `run` takes every ready peer, and `runOnly` takes exactly the identities
// `put-suite-build` just published (spec 32-4).
//
// The checks of every red feature (spec 52-3) come down in the same index and
// go onto the disk in the same pass as the main suite, as one union; the main
// suite then runs with their tags excluded, so the map never sees a scenario
// of a feature not built. Then each feature's checks run by their own tag
// (spec 52-4, AC 1.1), into the same batch under the feature's digest — one
// more independent branch each; the server answers with one line per feature,
// and what it shows on the map for them is its own business.
interface Deps {
  getSuiteIndex: () => Promise<SuiteIndex>;
  postRunsBatch: (runs: unknown[]) => Promise<{ results: RunResultItem[]; map_url: string }>;
  materializeStructural: (projectRoot: string, item: SuiteListItem) => void;
  materializeBehavioral: (projectRoot: string, index: SuiteIndex, runner: string) => { mainPath: string; excludeTags: string[] };
  runStructural: (projectRoot: string, runner: string, suitePaths: string[]) => Promise<RunnerResult>;
  runBehavioral: (projectRoot: string, runner: string, mainPath: string, filter?: TagFilter) => Promise<RunnerResult>;
  validateStack: (projectRoot: string, runner: string) => PrecheckResult;
  stdout: { write: (chunk: string) => unknown };
}

// `check`/`run`: execute every ready peer. This is the standalone flow the user
// asks for by name, and the recovery path after an interrupted first run.
export async function run(config: Config, _args: string[], deps?: Partial<Deps>): Promise<void> {
  return execute(config, resolve(config, deps), null);
}

// The first run that `put-suite-build` performs itself (spec 32-4): execute
// exactly the suite identities publication just returned, or none of them. Every
// requested identity must still be the current one — see `select`. Callers pass a
// non-empty list; "nothing was published" is decided and reported one level up,
// where the publication results that explain it are still in hand.
export async function runOnly(config: Config, digests: string[], deps?: Partial<Deps>): Promise<void> {
  return execute(config, resolve(config, deps), digests);
}

function resolve(config: Config, deps?: Partial<Deps>): Deps {
  const wire = new Wire(config);
  return {
    getSuiteIndex: () => wire.getSuiteIndex(),
    postRunsBatch: (runs) => wire.postRunsBatch(runs),
    // The whole envelope, support files and all: a branch is a set of files
    // since spec one-place-per-rule, §6, and picking `path` and `content` out of it here was
    // where the rest of them used to be lost.
    materializeStructural: (projectRoot, item) =>
      materializeGuardrails(projectRoot, {
        suite_digest: item.suite_digest!,
        suite_file: item.suite_file!,
        runner_manifest: item.runner_manifest!,
      }),
    // The union is never empty here: the caller only asks once the behavioral
    // peer is ready or a feature has checks, so at least one envelope is in it.
    materializeBehavioral: (projectRoot, index, runner) => materializeBehavioralUnion(projectRoot, index, runner)!,
    runStructural: runStructuralByRunner,
    runBehavioral: runBddSuite,
    validateStack,
    stdout: process.stdout,
    ...deps,
  };
}

async function execute(config: Config, d: Deps, only: string[] | null): Promise<void> {
  // Spec 36, criterion 7. Before the first suite is fetched: a run that cannot
  // happen where this project's dependencies live has nothing honest to file,
  // and the whole batch would go up as suite errors describing the wrong thing.
  const unusable = placeProblem(config.projectRoot) ?? runnerEnvironmentPlaceProblem(config.projectRoot);
  if (unusable) throw new Error(`${unusable}\nNothing was run and no results were filed.`);

  const index = await d.getSuiteIndex();
  const ready = index.suites.filter((item) => item.status === 'ready');
  const selected = only === null ? ready : select(ready, only);
  // The features' checks ride with the behavioral branch: every run of `check`
  // has them, and the first run after publishing has them when the behavioral
  // branch is what was published — structural alone has no union to run on.
  const features = only === null || selected.some((item) => item.suite_kind === 'behavioral') ? index.feature_suites : [];

  if (selected.length === 0 && features.length === 0) {
    d.stdout.write('No Unitbob suites exist yet. Generate them first, then run the Unitbob checks again.\n');
    return;
  }

  const unionFor = unionOnce(config, d, index);
  const runs: unknown[] = [];
  for (const item of selected) {
    runs.push(await buildRunPayload(config, d, item, unionFor));
  }
  for (const item of features) {
    runs.push(await buildFeatureRunPayload(config, d, item, unionFor));
  }

  const { results, map_url } = await d.postRunsBatch(runs);
  for (const result of results) d.stdout.write(`${result.summary}\n`);
  // The token joins the address here rather than on the server, so it stays out
  // of response bodies and out of the brain's logs (spec 33).
  if (map_url) d.stdout.write(`${enterUrl(config, map_url)}\n`);
}

// All-or-nothing. Publication and this fetch are two requests, so another client
// can republish in between. Running whatever is current instead would file honest
// results against a version the user never asked about, and silently substituting
// an older suite for a branch that failed to publish would be worse still. So a
// requested identity that is no longer current stops the whole run.
function select(ready: SuiteListItem[], wanted: string[]): SuiteListItem[] {
  const byDigest = new Map(ready.map((item) => [item.suite_digest ?? '', item]));
  const missing = wanted.filter((digest) => !byDigest.has(digest));

  if (missing.length > 0) {
    throw new Error(
      `The suite this project just published (${missing.join(', ')}) is no longer the current one — ` +
        'something else replaced it while this command was running. Nothing was run, so no results were ' +
        'filed against the wrong version.',
    );
  }

  return wanted.map((digest) => byDigest.get(digest)!);
}

// The union on disk — the main suite and every feature's checks — written
// once per run, by whichever behavioral branch asks first, and shared by the
// rest: the main suite runs on it with the feature tags excluded, each
// feature runs on it by its tag. A union that could not be written is one
// answer for all of them, filed as each branch's suite error.
type Union = { mainPath: string; excludeTags: string[] } | { error: string };

function unionOnce(config: Config, d: Deps, index: SuiteIndex): (runner: string) => Union {
  let union: Union | null = null;
  return (runner) => {
    if (union) return union;
    try {
      union = d.materializeBehavioral(config.projectRoot, index, runner);
    } catch (err) {
      // Not a branch's error to file and move past: the union refused to wipe
      // a feature's rewired checks (spec 52-4, AC 1.8). Nothing was run,
      // nothing is posted, and the sentence reaches the terminal through
      // `cli.ts`.
      if (err instanceof FeatureFilesChangedError) throw err;
      union = { error: (err as Error).message };
    }
    return union;
  };
}

// One branch's run payload. A stack mismatch, a materialize failure, or a runner
// that produced no report all become this branch's structured suite error — the
// peer branch is unaffected. This connector never installs anything: a missing
// or broken runner surfaces here as a suite error, not an install.
async function buildRunPayload(config: Config, d: Deps, item: SuiteListItem, unionFor: (runner: string) => Union): Promise<unknown> {
  const runner = item.runner_manifest!.runner;
  const digest = item.suite_digest!;

  // Confirm the local stack before touching the tree, for both contract systems.
  // A mismatch is this branch's suite error — reported and left for the peer
  // branch to run regardless. The behavioral check confirms only the base
  // language; a missing BDD runner still surfaces from the run itself, since
  // check installs nothing.
  const check = d.validateStack(config.projectRoot, runner);
  if (!check.ok) return suiteError(digest, check.message ?? `Local project does not match "${runner}".`);

  if (item.suite_kind !== 'behavioral') {
    return filed(runner, digest, async () => {
      d.materializeStructural(config.projectRoot, item);
      return d.runStructural(config.projectRoot, runner, artifactPaths(item.suite_file!));
    });
  }
  const union = unionFor(runner);
  if ('error' in union) return suiteError(digest, union.error);
  return filed(runner, digest, () => d.runBehavioral(config.projectRoot, runner, union.mainPath, { exclude: union.excludeTags }));
}

// One feature's run payload (spec 52-4, AC 1.1): the same checks a branch
// gets, the same union, only its own tag — and its own suite error when it
// cannot run, which stops nothing else.
async function buildFeatureRunPayload(config: Config, d: Deps, item: FeatureSuiteItem, unionFor: (runner: string) => Union): Promise<unknown> {
  const runner = item.runner_manifest.runner;
  const check = d.validateStack(config.projectRoot, runner);
  if (!check.ok) return suiteError(item.suite_digest, check.message ?? `Local project does not match "${runner}".`);

  const union = unionFor(runner);
  if ('error' in union) return suiteError(item.suite_digest, union.error);
  return filed(runner, item.suite_digest, () => d.runBehavioral(config.projectRoot, runner, union.mainPath, { only: item.feature_tag }));
}

// The run itself, filed as this branch's payload: a runner that could not
// start or a report that cannot be read is its structured suite error.
async function filed(runner: string, digest: string, execute: () => Promise<RunnerResult>): Promise<unknown> {
  let result: RunnerResult;
  try {
    result = await execute();
  } catch (err) {
    return suiteError(digest, (err as Error).message);
  }

  const report = boundReport(runner, result);
  if (report === null) {
    return {
      suite_digest: digest,
      suite_error: {
        command: [result.command, ...result.args].join(' '),
        exit_code: result.code,
        result_path: result.resultPath,
        output_tail: outputTail(result, OUTPUT_TAIL_CHARS),
      },
    };
  }
  return { suite_digest: digest, run_result: report };
}

// Exported for `run-local`, which runs these same strategies against the files
// the host just wrote rather than against a published suite. One dispatch table,
// so the command the loop iterates on is the command that runs after publishing.
export function runStructuralByRunner(
  projectRoot: string,
  runner: string,
  suitePaths: string[],
): Promise<RunnerResult> {
  switch (runner) {
    case 'rspec':
      return runRspecSuite(projectRoot, suitePaths);
    case 'vitest':
      return runVitestSuite(projectRoot, suitePaths);
    case 'pytest':
      return runPytestSuite(projectRoot, suitePaths);
    default:
      return Promise.reject(new Error(`Unsupported runner "${runner}" — rebuild the suite.`));
  }
}

// Every file of the branch, in the order the envelope carries them. A structural
// branch is one file per assignment since spec one-place-per-rule, §6, and running only the main
// one would execute a fraction of what the map says is guarded.
//
// Every file except the branch's shared setup file, which `testPathsOf` drops
// (spec 39): it is named in `setupFiles` instead of being collected from.
function artifactPaths(file: SuiteArtifact): string[] {
  return testPathsOf([file.path, ...(file.support_files ?? []).map((entry) => entry.path)]);
}

function suiteError(suiteDigest: string, message: string): unknown {
  return {
    suite_digest: suiteDigest,
    suite_error: { command: '', exit_code: null, result_path: '', output_tail: message },
  };
}

