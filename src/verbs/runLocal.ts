import type { Config } from '../config.ts';
import {
  branchRunner,
  readHostSuiteOutputsPerBranch,
  readSuiteBuildRequest,
  type HostBranchOutput,
  type SuiteBuildRequest,
} from '../files/suiteBuild.ts';
import { validateStack } from '../runner/precheck.ts';
import { runBddSuite } from '../runner/bdd.ts';
import { runStructuralByRunner } from './run.ts';
import type { RunnerResult } from '../runner/types.ts';

const OUTPUT_TAIL_CHARS = 4000;

// `unitbob run-local` — run the suite sitting on this machine, before any of it
// has been published.
//
// Both generation recipes end with "run it locally and iterate before handing it
// off", and both also say "the runner command is connector-owned". Until now
// those two sentences had nothing between them: `run`/`check` fetch published
// suites from the server, so there was no way to execute a candidate that had
// not been uploaded yet — which is every candidate, during the entire loop where
// the iterating actually happens.
//
// On the a2time run of 2026-08-04 the host agent closed that gap by guessing:
// it reconstructed `--require` and `BUNDLE_GEMFILE` from the recipe's file tree
// and got them right. Guessing right is not a plan. Worse, a guess that runs a
// *slightly* different command than the connector will run later moves the
// iteration onto a harness nobody will ever use again, so the round of repairs
// it buys can be repairs to the wrong thing.
//
// This runs the same strategies `check` runs, dispatched the same way, on the
// files the host just wrote. It interprets nothing: it prints the command, the
// exit code, where the machine-readable report landed, and the tail of what the
// process said. Joining results to the map stays the server's job — this exists
// so that when the recipe says "iterate", there is something to iterate on.
export interface RunLocalDeps {
  runStructural: (projectRoot: string, runner: string, suitePath: string) => Promise<RunnerResult>;
  runBehavioral: (projectRoot: string, runner: string, mainPath: string) => Promise<RunnerResult>;
  validateStack: typeof validateStack;
  stdout: { write: (chunk: string) => unknown };
}

export async function runLocal(
  config: Config,
  args: string[] = [],
  deps?: Partial<RunLocalDeps>,
): Promise<void> {
  const d: RunLocalDeps = {
    runStructural: runStructuralByRunner,
    runBehavioral: runBddSuite,
    validateStack,
    stdout: process.stdout,
    ...deps,
  };

  const request = readSuiteBuildRequest(config.projectRoot);
  const { outputs, unreadable } = readHostSuiteOutputsPerBranch(request.output_path, request);
  const wanted = selectBranches(request, args);

  for (const suiteKind of wanted) {
    d.stdout.write(`\n── ${suiteKind} ──\n`);

    // An entry that exists but will not parse is a different problem from an
    // entry that is not there, and it is the one worth catching early: the file
    // it names is usually missing from disk, which the runner would otherwise
    // discover as a confusing "no tests" halfway through the loop.
    const broken = unreadable.find((entry) => entry.suite_kind === suiteKind);
    if (broken) {
      d.stdout.write(`Cannot run this branch — its entry in your answer could not be read: ${broken.message}\n`);
      continue;
    }

    await runOneBranch(config, d, suiteKind, outputs.find((entry) => entry.suite_kind === suiteKind));
  }
}

// Which branches to run. No argument runs every branch the request asked for —
// the same "one suite, one run" shape both recipes insist on, so the default
// never teaches the habit the recipes forbid. A named branch is for the repair
// loop, where re-running the finished peer is pure cost.
function selectBranches(request: SuiteBuildRequest, args: string[]): string[] {
  const all = request.branches.map((branch) => branch.suite_kind);
  const named = args.filter((arg) => !arg.startsWith('-'));
  if (named.length === 0) return all;

  const unknown = named.filter((name) => !all.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `This suite build has no branch called ${unknown.join(', ')}. It asked for: ${all.join(', ')}.`,
    );
  }
  return named;
}

async function runOneBranch(
  config: Config,
  d: RunLocalDeps,
  suiteKind: string,
  output: HostBranchOutput | undefined,
): Promise<void> {
  // Nothing written for this branch yet. That is the ordinary state halfway
  // through a build, not an error — say what is missing and move to the peer.
  if (!output) {
    d.stdout.write(
      `Nothing to run: your answer has no entry for this branch yet. Write its suite under ` +
        `${branchRoot(config, suiteKind)} and add its entry to the answer, then run this again.\n`,
    );
    return;
  }

  if (output.build_error) {
    d.stdout.write(`Not built, by your own answer: ${output.build_error.message}\n`);
    return;
  }

  let runner: string;
  let suitePath: string;
  try {
    runner = branchRunner(output);
    suitePath = mainPathOf(output);
  } catch (err) {
    d.stdout.write(`Cannot run this branch: ${(err as Error).message}\n`);
    return;
  }

  const check = d.validateStack(config.projectRoot, runner);
  if (!check.ok) {
    d.stdout.write(`Cannot run this branch: ${check.message ?? `this project does not match "${runner}".`}\n`);
    return;
  }

  let result: RunnerResult;
  try {
    result =
      suiteKind === 'behavioral'
        ? await d.runBehavioral(config.projectRoot, runner, suitePath)
        : await d.runStructural(config.projectRoot, runner, suitePath);
  } catch (err) {
    d.stdout.write(`The runner could not start: ${(err as Error).message}\n`);
    return;
  }

  d.stdout.write(report(result));
}

// The command first, and always — including on a green run. It is the answer to
// "how do I run just this one file again", which is the question the whole
// iteration loop is made of, and printing it only on failure would hide it at
// exactly the moment someone starts trusting the loop.
function report(result: RunnerResult): string {
  const lines = [
    `ran: ${[result.command, ...result.args].join(' ')}`,
    `exit code: ${result.code}`,
  ];

  if (result.report) {
    lines.push(
      `machine-readable report: ${result.resultPath}` +
        ' — the whole run in one file, if the console output is too long to read.',
    );
  } else {
    lines.push(
      `no report at ${result.resultPath} — the run produced none, which usually means it died before` +
        ' the first test rather than that the tests failed.',
    );
  }

  const tail = outputTail(result);
  if (tail) lines.push('', tail);
  return `${lines.join('\n')}\n`;
}

function outputTail(result: RunnerResult): string {
  const bits: string[] = [];
  if (result.stderr.trim()) bits.push(result.stderr.trim());
  if (result.stdout.trim()) bits.push(result.stdout.trim());
  const joined = bits.join('\n');
  return joined.length > OUTPUT_TAIL_CHARS ? joined.slice(-OUTPUT_TAIL_CHARS) : joined;
}

// The suite blob's own project-relative path, exactly as the runners expect it.
function mainPathOf(output: HostBranchOutput): string {
  const file = output.suite_file as Record<string, unknown> | undefined;
  const path = file?.path;
  if (typeof path !== 'string' || !path) {
    throw new Error('this branch names no suite file to run.');
  }
  return path;
}

function branchRoot(config: Config, suiteKind: string): string {
  const request = readSuiteBuildRequest(config.projectRoot);
  return request.branches.find((branch) => branch.suite_kind === suiteKind)?.path_root ?? `.unitbob/${suiteKind}/`;
}
