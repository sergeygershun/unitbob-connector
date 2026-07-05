import type { Config } from '../config.ts';
import { materializeGuardrails, type SuiteBlob } from '../files/guardrails.ts';
import { runtimePrecheck } from '../runner/precheck.ts';
import { runRspecSuite, type RspecRunResult } from '../runner/rspec.ts';
import { Wire, type RunSummary } from '../wire.ts';

// Bound failure text for transport/storage hygiene (spec 26). This is a size
// limit only, not a privacy filter — application values in failure messages are
// accepted, not scrubbed.
const MAX_FAILURE_CHARS = 4000;

interface Deps {
  getSuite: () => Promise<SuiteBlob | null>;
  postRun: (payload: unknown) => Promise<RunSummary>;
  materializeGuardrails: (projectRoot: string, suite: SuiteBlob) => { suitePath: string };
  runRspecSuite: (projectRoot: string) => Promise<RspecRunResult>;
  precheck: (projectRoot: string) => { ok: boolean; message?: string };
  stdout: { write: (chunk: string) => unknown };
}

export async function run(config: Config, _args: string[], deps?: Partial<Deps>): Promise<void> {
  const wire = new Wire(config);
  const d: Deps = {
    getSuite: () => wire.getSuite(),
    postRun: (payload) => wire.postRun(payload),
    materializeGuardrails,
    runRspecSuite,
    precheck: runtimePrecheck,
    stdout: process.stdout,
    ...deps,
  };

  const check = d.precheck(config.projectRoot);
  if (!check.ok) throw new Error(check.message ?? 'Unsupported runtime.');

  const suite = await d.getSuite();
  if (suite === null) {
    d.stdout.write('No Unitbob suite exists yet. Generate the test suite first, then run /unitbob check again.\n');
    return;
  }

  d.materializeGuardrails(config.projectRoot, suite);

  const result =
    await d.runRspecSuite(config.projectRoot).catch((err) => ({
      stdout: '',
      stderr: (err as Error).message,
      code: null,
      command: 'rspec',
      args: [],
      jsonReport: '',
    }));

  const payload = rawRunPayload(suite.suite_digest, result);
  const summary = await d.postRun(payload);
  d.stdout.write(`${summary.summary}\n`);
  if (summary.map_url) d.stdout.write(`${summary.map_url}\n`);
}

// The RSpec JSON report comes from the `--out` file (`jsonReport`), which the app
// under test cannot pollute. Stdout is only a fallback for a runner double that
// emits its report there; anything unparseable is a genuine suite error.
function rawRunPayload(suiteDigest: string, result: RspecRunResult): unknown {
  const parsed = parseJsonObject(result.jsonReport) ?? parseJsonObject(result.stdout);
  if (parsed) return { suite_digest: suiteDigest, rspec_json: boundFailures(parsed) };

  return {
    suite_digest: suiteDigest,
    suite_error: suiteErrorMessage(result),
  };
}

// Truncate long per-example failure message/backtrace before transport. Other
// fields pass through untouched; Rails owns the capability join and status mapping.
function boundFailures(rspecJson: Record<string, unknown>): Record<string, unknown> {
  const examples = rspecJson.examples;
  if (!Array.isArray(examples)) return rspecJson;

  const bounded = examples.map((example) => {
    if (!example || typeof example !== 'object') return example;
    const ex = example as Record<string, unknown>;
    const exception = ex.exception;
    if (!exception || typeof exception !== 'object') return ex;

    const exc = exception as Record<string, unknown>;
    const next: Record<string, unknown> = { ...exc };
    if (typeof exc.message === 'string') next.message = truncate(exc.message);
    if (Array.isArray(exc.backtrace)) next.backtrace = exc.backtrace.slice(0, 20);
    return { ...ex, exception: next };
  });

  return { ...rspecJson, examples: bounded };
}

function truncate(text: string): string {
  return text.length > MAX_FAILURE_CHARS ? `${text.slice(0, MAX_FAILURE_CHARS)}… (truncated)` : text;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function suiteErrorMessage(result: RspecRunResult): string {
  const bits: string[] = [];
  if (result.code !== 0 && result.code !== null) bits.push(`exit ${result.code}`);
  if (result.stderr.trim()) bits.push(`stderr: ${truncate(result.stderr.trim())}`);
  if (result.stdout.trim()) bits.push(`stdout: ${result.stdout.trim().slice(0, 1000)}`);
  return bits.length > 0 ? bits.join(' | ') : 'RSpec output was not parseable JSON';
}
