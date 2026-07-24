import type { RunnerResult } from './types.ts';

// Size-bound the raw machine-readable report before transport (spec 26/30/32).
// This is a size limit only, not a privacy filter: application values in failure
// messages are accepted, not scrubbed. `null` means "no usable report" — the
// caller takes the structured suite-error path.
//
// Structural JSON/XML reports are parsed only to bound per-failure text, then
// re-serialized. Behavioral reports (Cucumber Messages NDJSON, pytest-bdd JSON)
// are bounded by whole-document size and shipped verbatim — Rails owns every bit
// of their interpretation.
const MAX_FAILURE_CHARS = 8000;
const MAX_REPORT_CHARS = 4_000_000;

export function boundReport(runner: string, result: RunnerResult): string | null {
  switch (runner) {
    case 'pytest':
      return result.report.trim() ? boundJunitXml(result.report) : null;
    case 'rspec':
    case 'vitest': {
      const parsed = parseJsonObject(result.report) ?? (runner === 'rspec' ? parseJsonObject(result.stdout) : null);
      if (!parsed) return null;
      const bounded = runner === 'rspec' ? boundRspecFailures(parsed) : boundVitestFailures(parsed);
      return JSON.stringify(bounded);
    }
    case 'cucumber':
    case 'cucumber-js':
    case 'pytest-bdd':
      return boundWhole(result.report);
    default:
      return boundWhole(result.report);
  }
}

// A behavioral report is shipped whole. An empty one is "no usable report" so
// the caller reports a suite error rather than an empty green.
function boundWhole(report: string): string | null {
  if (!report.trim()) return null;
  return report.length > MAX_REPORT_CHARS ? report.slice(0, MAX_REPORT_CHARS) : report;
}

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

function boundJunitXml(xml: string): string {
  const boundedBodies = xml.replace(
    /(<(failure|error|skipped|system-out|system-err)\b[^>]*>)([\s\S]*?)(<\/\2>)/g,
    (_match, open: string, _tag: string, body: string, close: string) =>
      `${boundXmlMessageAttr(open)}${boundXmlText(body)}${close}`,
  );
  return boundedBodies.replace(/<(failure|error|skipped)\b[^>]*\/>/g, (tag) => boundXmlMessageAttr(tag));
}

function boundXmlMessageAttr(tag: string): string {
  return tag.replace(/(\bmessage=")([\s\S]*?)(")/, (_m, pre: string, value: string, post: string) =>
    value.length > MAX_FAILURE_CHARS ? `${pre}${boundXmlText(value)}… (truncated)${post}` : `${pre}${value}${post}`,
  );
}

function boundXmlText(text: string): string {
  return text.length > MAX_FAILURE_CHARS ? `${truncateXml(text)}… (truncated)` : text;
}

function truncateXml(text: string): string {
  return text.slice(0, MAX_FAILURE_CHARS).replace(/&[^;]*$/, '');
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
