import type { Config } from '../config.ts';
import { materializeGuardrails } from '../files/guardrails.ts';
import { materializeBehavioral } from '../files/behavioral.ts';
import { validateStack, type PrecheckResult } from '../runner/precheck.ts';
import { runRspecSuite } from '../runner/rspec.ts';
import { runVitestSuite } from '../runner/vitest.ts';
import { runPytestSuite } from '../runner/pytest.ts';
import { runBddSuite } from '../runner/bdd.ts';
import type { RunnerResult } from '../runner/types.ts';
import { boundReport } from '../runner/boundReport.ts';
import { Wire, type RunResultItem, type SuiteListItem } from '../wire.ts';

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
interface Deps {
  getSuites: () => Promise<SuiteListItem[]>;
  postRunsBatch: (runs: unknown[]) => Promise<{ results: RunResultItem[]; map_url: string }>;
  materializeStructural: (projectRoot: string, item: SuiteListItem) => void;
  materializeBehavioral: (projectRoot: string, item: SuiteListItem) => string;
  runStructural: (projectRoot: string, runner: string, suitePath: string) => Promise<RunnerResult>;
  runBehavioral: (projectRoot: string, runner: string, mainPath: string) => Promise<RunnerResult>;
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
    getSuites: () => wire.getSuites(),
    postRunsBatch: (runs) => wire.postRunsBatch(runs),
    materializeStructural: (projectRoot, item) =>
      materializeGuardrails(projectRoot, {
        suite_digest: item.suite_digest!,
        suite_file: { path: item.suite_file!.path, content: item.suite_file!.content },
        runner_manifest: item.runner_manifest!,
      }),
    materializeBehavioral: (projectRoot, item) =>
      materializeBehavioral(projectRoot, item.suite_file!, item.runner_manifest!.runner).mainPath,
    runStructural: runStructuralByRunner,
    runBehavioral: runBddSuite,
    validateStack,
    stdout: process.stdout,
    ...deps,
  };
}

async function execute(config: Config, d: Deps, only: string[] | null): Promise<void> {
  const suites = await d.getSuites();
  const ready = suites.filter((item) => item.status === 'ready');
  const selected = only === null ? ready : select(ready, only);

  if (selected.length === 0) {
    d.stdout.write('No Unitbob suites exist yet. Generate them first, then run the Unitbob checks again.\n');
    return;
  }

  const runs: unknown[] = [];
  for (const item of selected) {
    runs.push(await buildRunPayload(config, d, item));
  }

  const { results, map_url } = await d.postRunsBatch(runs);
  for (const result of results) d.stdout.write(`${result.summary}\n`);
  if (map_url) d.stdout.write(`${map_url}\n`);
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

// One branch's run payload. A stack mismatch, a materialize failure, or a runner
// that produced no report all become this branch's structured suite error — the
// peer branch is unaffected. This connector never installs anything: a missing
// or broken runner surfaces here as a suite error, not an install.
async function buildRunPayload(config: Config, d: Deps, item: SuiteListItem): Promise<unknown> {
  const runner = item.runner_manifest!.runner;
  const behavioral = item.suite_kind === 'behavioral';

  // Confirm the local stack before touching the tree, for both contract systems.
  // A mismatch is this branch's suite error — reported and left for the peer
  // branch to run regardless. The behavioral check confirms only the base
  // language; a missing BDD runner still surfaces from the run itself, since
  // check installs nothing.
  const check = d.validateStack(config.projectRoot, runner);
  if (!check.ok) return suiteError(item.suite_digest!, check.message ?? `Local project does not match "${runner}".`);

  let result: RunnerResult;
  try {
    if (behavioral) {
      const mainPath = d.materializeBehavioral(config.projectRoot, item);
      result = await d.runBehavioral(config.projectRoot, runner, mainPath);
    } else {
      d.materializeStructural(config.projectRoot, item);
      result = await d.runStructural(config.projectRoot, runner, item.suite_file!.path);
    }
  } catch (err) {
    return suiteError(item.suite_digest!, (err as Error).message);
  }

  const report = boundReport(runner, result);
  if (report === null) {
    return {
      suite_digest: item.suite_digest,
      suite_error: {
        command: [result.command, ...result.args].join(' '),
        exit_code: result.code,
        result_path: result.resultPath,
        output_tail: outputTail(result),
      },
    };
  }
  return { suite_digest: item.suite_digest, run_result: report };
}

function runStructuralByRunner(projectRoot: string, runner: string, suitePath: string): Promise<RunnerResult> {
  switch (runner) {
    case 'rspec':
      return runRspecSuite(projectRoot, suitePath);
    case 'vitest':
      return runVitestSuite(projectRoot, suitePath);
    case 'pytest':
      return runPytestSuite(projectRoot, suitePath);
    default:
      return Promise.reject(new Error(`Unsupported runner "${runner}" — rebuild the suite.`));
  }
}

function suiteError(suiteDigest: string, message: string): unknown {
  return {
    suite_digest: suiteDigest,
    suite_error: { command: '', exit_code: null, result_path: '', output_tail: message },
  };
}

function outputTail(result: RunnerResult): string {
  const bits: string[] = [];
  if (result.stderr.trim()) bits.push(result.stderr.trim());
  if (result.stdout.trim()) bits.push(result.stdout.trim());
  const joined = bits.join('\n');
  return joined.length > OUTPUT_TAIL_CHARS ? joined.slice(-OUTPUT_TAIL_CHARS) : joined;
}
