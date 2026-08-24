import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Spec 34-6, criterion 3. Removing `repair_rounds` took away the only thing that
// could ever end a repair loop, and the counter it took away was the wrong shape
// anyway: it stopped a branch after N runs whether those runs were making
// progress or not.
//
// This is the mechanical replacement, and it is the whole of it: the same set of
// failures twice in a row means the edits between them changed nothing. That is
// observable, cheap, and — unlike a round count — silent while repair is working.
//
// The set is canonical, not the report. Two runs of the same broken suite differ
// in timings, seeds, object ids and execution order, so hashing the report would
// say "something changed" every single time. What identifies a failure for this
// purpose is: which case failed (its Unitbob marker), where it lives, and the
// first line of what it said. Sorted, so a runner that reorders its examples
// does not look like progress.
export interface Failure {
  marker: string;
  file: string;
  message: string;
}

// Spec 37-2, criterion 5. Same parse, read for the other question.
//
// The three fields above are what identifies a failure across two runs, and they
// are deliberately less than what a person needs to act on one: no name, no
// step, and only the first line of the message. Until now that was all the
// connector ever produced from a report, so the coordinator opened
// `pytest_bdd_report.json` and `pytest_result.xml` with inline `node -e` and
// `python3` — at 300,000 tokens of context per turn — to recover the rest. The
// format is this module's knowledge; it does not become the coordinator's
// because nobody printed it.
//
// `detail` is the whole message rather than its first line, and it is on this
// record alone: nothing here reaches the digest, so drifting object ids and
// absolute paths cost nothing.
export interface ReportedFailure extends Failure {
  name: string;
  step: string;
  detail: string;
}

export const RUN_STATE_FILE = 'run-state.json';

// A marker embedded in a reported test name or Gherkin tag. Same shape the
// server joins on (`CaseMarker::EMBEDDED`): a full 12-hex marker, never a prefix
// of a longer hex run. A case with no marker still counts as a failure — it is
// identified by its file and message alone.
const MARKER = /ubc_[0-9a-f]{12}(?![0-9a-f])/;

// The failures a report describes, canonically ordered, or `null` when the
// report cannot be read as one. `null` is not "green": a runner that died before
// the first test produces no set at all, and comparing against nothing would
// stop a branch over a harness problem the loop never even reached.
export function failureSet(runner: string, report: string): Failure[] | null {
  const found = reportedFailures(runner, report);
  return found && canonical(found.map(({ marker, file, message }) => ({ marker, file, message })));
}

// The same failures, with everything a reader needs and the comparison does not.
// Reported in the order the runner reported them: this list is read by a person
// deciding what to repair, and a run's own order is the one that matches the
// console output next to it.
export function reportedFailures(runner: string, report: string): ReportedFailure[] | null {
  if (!report.trim()) return null;
  return extract(runner, report);
}

// One hash for one set. Same set, same hash, on any machine and in any order.
export function digestOf(failures: Failure[]): string {
  return createHash('sha256').update(JSON.stringify(failures)).digest('hex');
}

export function runStatePath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', RUN_STATE_FILE);
}

// A damaged, hand-edited or absent file reads as "no previous run". Refusing to
// run over a bookkeeping file would turn the one soft stop in the loop into the
// hardest thing in it — and this file is written by a process that repair
// deliberately kills and restarts.
export function readRunState(projectRoot: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(runStatePath(projectRoot), 'utf8')) as unknown;
    const branches = (parsed as Record<string, unknown> | null)?.branches;
    if (!branches || typeof branches !== 'object' || Array.isArray(branches)) return {};
    return Object.fromEntries(
      Object.entries(branches as Record<string, unknown>).filter(([, value]) => typeof value === 'string'),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

// `undefined` forgets this branch: a run that produced no comparable set leaves
// the next one to be a first run again.
export function rememberFailures(projectRoot: string, branch: string, digest: string | undefined): void {
  const branches = readRunState(projectRoot);
  if (digest === undefined) delete branches[branch];
  else branches[branch] = digest;

  const path = runStatePath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  // Written whole and moved into place. A plain write that is interrupted leaves
  // truncated JSON, which reads back as "no previous run" — exactly at the
  // moment a run is being killed and restarted, which is the loop this bounds.
  const staging = `${path}.tmp`;
  writeFileSync(staging, `${JSON.stringify({ branches }, null, 2)}\n`);
  renameSync(staging, path);
}

export function clearRunState(projectRoot: string): void {
  rmSync(runStatePath(projectRoot), { force: true });
}

function canonical(failures: Failure[]): Failure[] {
  const byKey = new Map(failures.map((failure) => [keyOf(failure), failure]));
  return [...byKey.keys()].sort().map((key) => byKey.get(key) as Failure);
}

function keyOf(failure: Failure): string {
  return `${failure.marker}\u0000${failure.file}\u0000${failure.message}`;
}

// The connector interprets a report in exactly one other place — `boundReport`,
// which bounds it for transport — and this switch deliberately mirrors that
// one's shape rather than inventing a second dispatch. Neither of them judges a
// run — the server owns every verdict a report leads to. This one only asks "is
// this the same wall we hit last time", and its answer reaches nothing but an
// exit code.
function extract(runner: string, report: string): ReportedFailure[] | null {
  switch (runner) {
    case 'rspec':
      return fromRspec(report);
    case 'vitest':
      return fromVitest(report);
    case 'pytest':
      return fromJunitXml(report);
    case 'cucumber':
    case 'cucumber-js':
      return fromCucumberMessages(report);
    case 'pytest-bdd':
      return fromPytestBdd(report);
    default:
      return null;
  }
}

function fromRspec(report: string): ReportedFailure[] | null {
  const data = parseObject(report);
  if (!Array.isArray(data?.examples)) return null;

  return rows(data.examples).flatMap((example) => {
    if (example.status === 'passed') return [];
    const name = `${text(example.description)} ${text(example.full_description)}`;
    const exception = example.exception as Record<string, unknown> | undefined;
    return [failure(name, text(example.file_path), text(exception?.message), {
      name: text(example.full_description) || text(example.description),
    })];
  });
}

function fromVitest(report: string): ReportedFailure[] | null {
  const data = parseObject(report);
  if (!Array.isArray(data?.testResults)) return null;

  return rows(data.testResults).flatMap((file) => {
    const assertions = Array.isArray(file.assertionResults) ? rows(file.assertionResults) : [];
    return assertions.flatMap((assertion) => {
      if (assertion.status === 'passed') return [];
      const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [];
      const name = `${text(assertion.title)} ${text(assertion.fullName)}`;
      return [failure(name, text(file.name), messages.map((m) => text(m)).join('\n'), {
        name: text(assertion.fullName) || text(assertion.title),
      })];
    });
  });
}

// pytest's JUnit XML, read the way `boundReport` already reads it: by pattern,
// because a whole XML parser to answer one yes/no question is a dependency this
// package does not need.
//
// `failure` and `error`, but not `skipped` — and this is the one place the set
// deliberately does not match the server's "did not pass". A skip never moves:
// it reports the same thing on every run forever, so counting it here would stop
// a branch whose only permanent case is a skip, and it would do it while the
// repair was still fixing everything else. A skip that should not be there is
// caught at upload, where it costs a message rather than a branch.
function fromJunitXml(report: string): ReportedFailure[] | null {
  if (!/<testsuites?\b/.test(report)) return null;

  // Self-closing first, and as its own alternative rather than a branch inside
  // one `[^>]*`. Written the other way the engine backtracks out of `\/>` into
  // `>[\s\S]*?<\/testcase>` and swallows the next element whole, so a passing
  // self-closed case immediately before a failing one hands back the passing
  // one's name and file. Harmless while this was only hashed; wrong the moment
  // spec 37-2 started printing it to somebody deciding what to repair.
  const cases = report.match(/<testcase\b[^>]*\/>|<testcase\b[^>]*>[\s\S]*?<\/testcase>/g) ?? [];
  return cases.flatMap((testcase) => {
    const problem = testcase.match(/<(failure|error)\b[^>]*\/>|<(failure|error)\b[^>]*>([\s\S]*?)<\/(?:failure|error)>/);
    if (!problem) return [];
    const name = attribute(testcase, 'name');
    const file = attribute(testcase, 'file') || attribute(testcase, 'classname');
    const message = attribute(problem[0], 'message');
    // pytest puts the one-line summary in `message=` and the assertion with its
    // traceback in the element's body. The body is what a person needs; the
    // attribute is what the digest compares, and changing its bytes would make
    // every branch look like it had moved once.
    const body = unescapeXml(problem[3] ?? '').trim();
    return [failure(name, file, message, {
      name,
      detail: [unescapeXml(message), body].filter(Boolean).join('\n'),
    })];
  });
}

// The five entities XML defines plus numeric references — pytest escapes its
// newlines as `&#10;`, and a traceback rendered as one line of `&#10;` is not a
// traceback. This is pytest's own writer on the other end, not arbitrary markup.
// `&amp;` last, so `&amp;lt;` comes back as `&lt;` rather than as `<`.
function unescapeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (whole, code) => codePoint(Number(code), whole))
    .replace(/&#x([0-9a-f]+);/gi, (whole, code) => codePoint(parseInt(code, 16), whole))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// A reference outside Unicode is left as it was written. Nothing here is worth
// throwing over: this runs while somebody is reading why their suite is red.
function codePoint(value: number, whole: string): string {
  try {
    return String.fromCodePoint(value);
  } catch {
    return whole;
  }
}

// Cucumber Messages (NDJSON), both the Ruby and the JS emitter. One scenario is
// spread over several envelopes: the pickle holds its name, tags and file, the
// testCase maps its steps, and testStepFinished carries each step's result.
function fromCucumberMessages(report: string): ReportedFailure[] | null {
  const envelopes: Record<string, unknown>[] = [];
  for (const line of report.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseObject(line);
    if (!parsed) return null;
    envelopes.push(parsed);
  }
  if (envelopes.length === 0) return null;

  const pickles = indexBy(envelopes, 'pickle');
  const testCases = indexBy(envelopes, 'testCase');
  const results = new Map<string, Record<string, unknown>[]>();
  for (const envelope of envelopes) {
    const finished = envelope.testStepFinished as Record<string, unknown> | undefined;
    if (!finished) continue;
    const startedId = text(finished.testCaseStartedId);
    const list = results.get(startedId) ?? [];
    list.push({
      // The step's own id travels with its result, so the text of the step that
      // failed can be recovered from the pickle it came from (spec 37-2,
      // criterion 5). Nothing in the digest reads it.
      testStepId: finished.testStepId,
      ...((finished.testStepResult as Record<string, unknown>) ?? {}),
    });
    results.set(startedId, list);
  }

  return envelopes.flatMap((envelope) => {
    const started = envelope.testCaseStarted as Record<string, unknown> | undefined;
    if (!started) return [];
    const testCase = testCases.get(text(started.testCaseId)) ?? {};
    const pickle = pickles.get(text(testCase.pickleId)) ?? {};
    const steps = results.get(text(started.id)) ?? [];
    const failed = steps.filter((step) => text(step.status) !== 'PASSED' && text(step.status) !== 'SKIPPED');
    if (failed.length === 0) return [];

    const tags = Array.isArray(pickle.tags) ? pickle.tags : [];
    const tagText = rows(tags).map((tag) => text(tag.name)).join(' ');
    const message = failed.map((step) => text(step.message)).find((line) => line.trim()) ?? '';
    return [failure(`${tagText} ${text(pickle.name)}`, text(pickle.uri), message, {
      name: text(pickle.name),
      step: cucumberStepText(failed[0], testCase, pickle),
    })];
  });
}

// Which step of that Scenario failed, in the words of the feature file. Three
// hops, because Cucumber Messages keeps the result, the mapping and the text in
// three different envelopes: result → testStep → pickleStep.
function cucumberStepText(
  failed: Record<string, unknown>,
  testCase: Record<string, unknown>,
  pickle: Record<string, unknown>,
): string {
  const testSteps = Array.isArray(testCase.testSteps) ? rows(testCase.testSteps) : [];
  const testStep = testSteps.find((step) => text(step.id) === text(failed.testStepId));
  if (!testStep) return '';
  const pickleSteps = Array.isArray(pickle.steps) ? rows(pickle.steps) : [];
  return text(pickleSteps.find((step) => text(step.id) === text(testStep.pickleStepId))?.text);
}

// The connector's own pytest-bdd report (`runner/pytestBddPlugin.ts`). Its
// `file` is the `.feature` the Scenario came from, and it is empty on a report
// written by a connector older than spec 37-2 — which is why it is read
// defensively rather than assumed.
function fromPytestBdd(report: string): ReportedFailure[] | null {
  const data = parseObject(report);
  if (!Array.isArray(data?.scenarios)) return null;

  return rows(data.scenarios).flatMap((scenario) => {
    if (text(scenario.status) === 'passed') return [];
    const tags = Array.isArray(scenario.tags) ? scenario.tags.map((tag) => text(tag)).join(' ') : '';
    // Our own plugin records one entry per step with its status, and marks the
    // one it caught the exception in — so the step is read, never guessed.
    const steps = Array.isArray(scenario.steps) ? rows(scenario.steps) : [];
    const broke = steps.find((step) => text(step.status) === 'failed');
    return [failure(`${tags} ${text(scenario.name)}`, text(scenario.file), text(scenario.failure), {
      name: text(scenario.name),
      step: broke ? `${text(broke.keyword)} ${text(broke.text)}`.trim() : '',
    })];
  });
}

// `message` is only the first line. Later lines are backtraces and diffs, which
// carry object ids and absolute paths that differ between two runs of the same
// unchanged failure — the very drift that would make the comparison useless.
// `detail` keeps all of it: nothing on that field is hashed.
function failure(
  name: string,
  file: string,
  message: string,
  extra: { name?: string; step?: string; detail?: string } = {},
): ReportedFailure {
  return {
    marker: name.match(MARKER)?.[0] ?? '',
    file,
    message: message.split('\n')[0]?.trim() ?? '',
    name: (extra.name ?? name).trim(),
    step: extra.step ?? '',
    detail: (extra.detail ?? message).trim(),
  };
}

function indexBy(envelopes: Record<string, unknown>[], key: string): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  for (const envelope of envelopes) {
    const item = envelope[key] as Record<string, unknown> | undefined;
    if (item) found.set(text(item.id), item);
  }
  return found;
}

function attribute(tag: string, name: string): string {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';
}

function rows(values: unknown[]): Record<string, unknown>[] {
  return values.filter((value): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseObject(source: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(source) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
