import type { Config } from '../config.ts';
import { materializeGuardrails, type SuiteBlob } from '../files/guardrails.ts';
import { validateStack, type PrecheckResult } from '../runner/precheck.ts';
import { runRspecSuite } from '../runner/rspec.ts';
import { runVitestSuite } from '../runner/vitest.ts';
import { runPytestSuite } from '../runner/pytest.ts';
import type { RunnerResult } from '../runner/types.ts';
import { Wire, type RunSummary } from '../wire.ts';

// Bound failure text for transport/storage hygiene (spec 26). This is a size
// limit only, not a privacy filter — application values in failure messages are
// accepted, not scrubbed.
const MAX_FAILURE_CHARS = 8000;
const OUTPUT_TAIL_CHARS = 2000;

interface Deps {
  getSuite: () => Promise<SuiteBlob | null>;
  postRun: (payload: unknown) => Promise<RunSummary>;
  materializeGuardrails: (projectRoot: string, suite: SuiteBlob) => { suitePath: string };
  runSuite: (projectRoot: string, runner: string, suitePath: string) => Promise<RunnerResult>;
  validateStack: (projectRoot: string, runner: string) => PrecheckResult;
  stdout: { write: (chunk: string) => unknown };
}

// The check flow (spec 30): fetch the current suite blob, confirm the local
// project matches its runner, materialize the guardrail file, execute the
// connector-owned strategy named by `runner_manifest.runner`, and ship the raw
// machine-readable report (or a structured runner error) to Rails.
export async function run(config: Config, _args: string[], deps?: Partial<Deps>): Promise<void> {
  const wire = new Wire(config);
  const d: Deps = {
    getSuite: () => wire.getSuite(),
    postRun: (payload) => wire.postRun(payload),
    materializeGuardrails,
    runSuite: runSuiteByRunner,
    validateStack,
    stdout: process.stdout,
    ...deps,
  };

  const suite = await d.getSuite();
  if (suite === null) {
    d.stdout.write('No Unitbob suite exists yet. Generate the test suite first, then run /unitbob check again.\n');
    return;
  }

  // Fail closed before touching the working tree: a stack mismatch writes no files.
  const runner = suite.runner_manifest.runner;
  const check = d.validateStack(config.projectRoot, runner);
  if (!check.ok) throw new Error(check.message ?? `Local project does not match the suite runner "${runner}".`);

  d.materializeGuardrails(config.projectRoot, suite);

  const result = await d.runSuite(config.projectRoot, runner, suite.suite_file.path).catch(
    (err): RunnerResult => ({
      stdout: '',
      stderr: (err as Error).message,
      code: null,
      command: runner,
      args: [],
      resultPath: '',
      report: '',
    }),
  );

  const payload = rawRunPayload(suite.suite_digest, runner, result);
  const summary = await d.postRun(payload);
  d.stdout.write(`${summary.summary}\n`);
  if (summary.map_url) d.stdout.write(`${summary.map_url}\n`);
}

// The connector-owned strategy table: `runner_manifest.runner` names one of
// these; only suite and result paths vary. Host-provided command strings are
// never executed.
function runSuiteByRunner(projectRoot: string, runner: string, suitePath: string): Promise<RunnerResult> {
  switch (runner) {
    case 'rspec':
      return runRspecSuite(projectRoot, suitePath);
    case 'vitest':
      return runVitestSuite(projectRoot, suitePath);
    case 'pytest':
      return runPytestSuite(projectRoot, suitePath);
    default:
      return Promise.reject(new Error(`Unsupported runner "${runner}" — rebuild the suite with /unitbob suite.`));
  }
}

// The machine-readable report comes from the runner's own output file, which
// the app under test cannot pollute. A run that produced no report is a
// structured suite error — command, exit code, expected result path, output
// tail — which Rails records without repainting capabilities.
function rawRunPayload(suiteDigest: string, runner: string, result: RunnerResult): unknown {
  const report = boundedReport(runner, result);
  if (report !== null) return { suite_digest: suiteDigest, run_result: report };

  return {
    suite_digest: suiteDigest,
    suite_error: {
      command: [result.command, ...result.args].join(' '),
      exit_code: result.code,
      result_path: result.resultPath,
      output_tail: outputTail(result),
    },
  };
}

// JSON reports (rspec, vitest) are parsed only to size-bound failure text, then
// re-serialized; the XML report is bounded per failure element the same way.
// `null` means "no usable report" — the suite-error path. Stdout is only a
// fallback for an rspec double that emits its report there.
function boundedReport(runner: string, result: RunnerResult): string | null {
  if (runner === 'pytest') return result.report.trim() ? boundJunitXml(result.report) : null;

  const parsed = parseJsonObject(result.report) ?? (runner === 'rspec' ? parseJsonObject(result.stdout) : null);
  if (!parsed) return null;

  const bounded = runner === 'rspec' ? boundRspecFailures(parsed) : boundVitestFailures(parsed);
  return JSON.stringify(bounded);
}

// Truncate long per-example failure message/backtrace before transport. Other
// fields pass through untouched; Rails owns the capability join and status mapping.
function boundRspecFailures(rspecJson: Record<string, unknown>): Record<string, unknown> {
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

function boundVitestFailures(vitestJson: Record<string, unknown>): Record<string, unknown> {
  const testResults = vitestJson.testResults;
  if (!Array.isArray(testResults)) return vitestJson;

  const bounded = testResults.map((fileResult) => {
    if (!fileResult || typeof fileResult !== 'object') return fileResult;
    const file = fileResult as Record<string, unknown>;
    const assertions = file.assertionResults;
    if (!Array.isArray(assertions)) return file;

    const next = assertions.map((assertion) => {
      if (!assertion || typeof assertion !== 'object') return assertion;
      const a = assertion as Record<string, unknown>;
      if (!Array.isArray(a.failureMessages)) return a;
      return { ...a, failureMessages: a.failureMessages.map((m) => (typeof m === 'string' ? truncate(m) : m)) };
    });
    return { ...file, assertionResults: next };
  });

  return { ...vitestJson, testResults: bounded };
}

function truncate(text: string): string {
  return text.length > MAX_FAILURE_CHARS ? `${text.slice(0, MAX_FAILURE_CHARS)}… (truncated)` : text;
}

// pytest's JUnit XML has no size bound of its own: one failing assertion can
// carry a multi-megabyte diff plus captured stdout/stderr. Bound the two things
// Rails reads (the failure/error/skipped `message` attribute and the element
// body) plus the captured-output blocks, keeping the document well-formed so
// Rails' strict XML parse still succeeds.
function boundJunitXml(xml: string): string {
  const boundedBodies = xml.replace(
    /(<(failure|error|skipped|system-out|system-err)\b[^>]*>)([\s\S]*?)(<\/\2>)/g,
    (_match, open: string, _tag: string, body: string, close: string) =>
      `${boundXmlMessageAttr(open)}${boundXmlText(body)}${close}`,
  );
  // Self-closing forms (e.g. <failure message="…"/>) carry everything in the attr.
  return boundedBodies.replace(/<(failure|error|skipped)\b[^>]*\/>/g, (tag) => boundXmlMessageAttr(tag));
}

function boundXmlMessageAttr(tag: string): string {
  // Attribute values escape their own quotes, so matching to the next `"` is safe.
  return tag.replace(/(\bmessage=")([\s\S]*?)(")/, (_m, pre: string, value: string, post: string) =>
    value.length > MAX_FAILURE_CHARS ? `${pre}${boundXmlText(value)}… (truncated)${post}` : `${pre}${value}${post}`,
  );
}

function boundXmlText(text: string): string {
  return text.length > MAX_FAILURE_CHARS ? `${truncateXml(text)}… (truncated)` : text;
}

// Slice without cutting inside an XML entity, which would break a strict parse.
function truncateXml(text: string): string {
  return text.slice(0, MAX_FAILURE_CHARS).replace(/&[^;]*$/, '');
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function outputTail(result: RunnerResult): string {
  const bits: string[] = [];
  if (result.stderr.trim()) bits.push(result.stderr.trim());
  if (result.stdout.trim()) bits.push(result.stdout.trim());
  const joined = bits.join('\n');
  return joined.length > OUTPUT_TAIL_CHARS ? joined.slice(-OUTPUT_TAIL_CHARS) : joined;
}
