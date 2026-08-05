import type { Config } from '../config.ts';
import {
  readHostSuiteOutputsPerBranch,
  readSuiteBuildRequest,
  type HostBranchOutput,
  type SuiteBuildBranch,
  type SuiteBuildRequest,
  type UnreadableBranch,
} from '../files/suiteBuild.ts';

// Spec 32-6 Phase 3. Everything checked here was already checked — by the
// server, at the end, after the suite had been written, run and reviewed. A
// format mistake made at 14:20 surfaced at 15:11 on the a2time run. The checks
// themselves are cheap; only their placement was expensive.
//
// This does not make the connector the authority on anything. The server stays
// the single source of truth, and one of its four reasons to reject — whether
// `source_digest` still matches the live map — depends on time and cannot be
// answered here at all. There is deliberately no rule that says "if this passes,
// the server must accept": that rule would need a list of exceptions for exactly
// the race it could not see, and the race matters less the shorter the run.
// What this buys is the feedback loop, in seconds instead of a full generation.
//
// Naming `covered`/`unguarded` here is the narrow exception the architecture
// guard records by file. The connector is not deciding what ought to be
// guarded — the server issued the assignment and the host answered it, and this
// only compares the two documents in front of it. That is the same line spec
// 32-5 drew for `runner_manifest`: selecting and checking against a server-owned
// envelope is transport; authoring one would not be.
//
// The cost of that exception, stated plainly: these rules also exist in
// `GuardrailSuiteOutputValidator`, and two copies can drift. Drift in one
// direction is harmless — the server rejects something this passed, which is
// the order of authority anyway. Drift in the other direction is not: a false
// positive here refuses an answer the server would have taken. That is why
// `put-suite-build` reports these against one branch instead of stopping the
// command — a wrong check can cost a branch, never the batch, and the peer goes
// up regardless. If these ever need to be more than a fast pre-read of the
// obvious mistakes, the rules should come down the wire from the server rather
// than be copied more thoroughly.
export interface BuildProblem {
  branch: string;
  message: string;
}

// The assignment, reduced to what a local check can compare against. Ids are
// recovered from `contract_key`, which the server derives as `contract:<id>` and
// both sides copy verbatim — so nothing here has to know whether this branch's
// ids are called `interface_id` or `capability_id`.
const CONTRACT_PREFIX = 'contract:';

interface AssignedCase {
  id: string;
  contract_key: string;
  case_marker: string;
  surfaces: string[];
}

export function collectBuildProblems(
  request: SuiteBuildRequest,
  outputs: HostBranchOutput[],
  unreadable: UnreadableBranch[] = [],
): BuildProblem[] {
  const problems: BuildProblem[] = [];
  const branchFor = new Map(request.branches.map((branch) => [branch.suite_kind, branch]));

  for (const output of outputs) {
    // The host said plainly that it could not build this one. That is an answer,
    // not a malformed answer, and the server records it as such.
    if (output.build_error) continue;

    const branch = branchFor.get(output.suite_kind);
    if (!branch) continue; // reading the answer already refused this one

    const add = (message: string): void => { problems.push({ branch: output.suite_kind, message }); };
    checkRunnerManifest(branch, output, add);
    checkAssignment(branch, output, add);
  }

  problems.push(...unansweredBranches(request, outputs, unreadable));
  return problems;
}

// The branch that is not there at all. Every check above reads the answer and
// asks whether it is well-formed; none of them can see a branch the answer never
// mentions, because there is no entry to walk. So this one walks the request
// instead — the only list that knows what was asked for.
//
// The a2time run of 2026-08-04 is the whole reason. Its behavioral branch was
// prepared, half-built and abandoned for budget; the answer went up carrying the
// structural branch alone; this check said "well-formed"; the upload published
// one branch and said nothing about the other. Nothing anywhere recorded that a
// second branch had ever been asked for, so the cost of the work already done on
// it was not merely wasted, it was invisible.
//
// ADR 1 names this shape: a pre-check must not be *narrower* than the thing it
// predicts. The server checks each branch it receives; what it cannot check is a
// branch nobody sent it. That gap belongs here, where the request is still in
// hand.
//
// `build_error` is the answer for a branch that could not be built, and it is
// deliberately cheap to give — one line, no suite, never blocks the peer. This
// does not demand the branch be built. It demands only that its absence be
// stated rather than left as a silence that reads like success.
//
// A branch whose entry existed but could not be parsed is already reported as
// unreadable by the caller; naming it "missing" too would be two complaints
// about one mistake, and the second would send the reader looking for a second
// problem that is not there.
function unansweredBranches(
  request: SuiteBuildRequest,
  outputs: HostBranchOutput[],
  unreadable: UnreadableBranch[],
): BuildProblem[] {
  const accounted = new Set<string>([
    ...outputs.map((output) => output.suite_kind),
    ...unreadable.map((entry) => entry.suite_kind),
  ]);

  return request.branches
    .filter((branch) => !accounted.has(branch.suite_kind))
    .map((branch) => ({
      branch: branch.suite_kind,
      message:
        'the request asked for this branch and the answer has no entry for it — it is neither built nor ' +
        'declared unbuildable. Every branch in the request gets one entry: the suite you built, or ' +
        `{ "suite_kind": "${branch.suite_kind}", "build_error": { "message": "why not" } }. ` +
        'Leaving it out is not the same as declining it: nothing records that this branch was ever asked ' +
        'for, so the work already spent on it disappears without a trace.',
    }));
}

// After spec 32-5 the envelope comes down from the server inside the request, so
// there is nothing here to derive — only to confirm the host copied it. This is
// the field most likely to be rejected after all the work is done, which is
// exactly why it is worth a second of checking beforehand.
function checkRunnerManifest(
  branch: SuiteBuildBranch,
  output: HostBranchOutput,
  add: (message: string) => void,
): void {
  if (branch.runner_manifest === undefined) return;

  if (!sameJson(branch.runner_manifest, output.runner_manifest)) {
    add(
      'runner_manifest does not match the one the request issued. Copy it verbatim — the server ' +
        'accepts only the exact combinations it named.\n' +
        `      issued:   ${stableJson(branch.runner_manifest)}\n` +
        `      answered: ${stableJson(output.runner_manifest)}`,
    );
  }
}

// Every assigned id accounted for exactly once, and every marker the one the
// server minted. A marker the host invented or edited severs the only join
// between a runner's output and the map, so it cannot be allowed to travel.
function checkAssignment(
  branch: SuiteBuildBranch,
  output: HostBranchOutput,
  add: (message: string) => void,
): void {
  const assigned = assignedCases(branch.assignment);
  if (assigned.length === 0) {
    // An assignment with no cases in it is normal — a map with nothing to guard
    // yet. An assignment that has content this walker could not read is not: the
    // check would pass everything from then on and never say why. Fail open, but
    // never fail open quietly.
    if (hasContent(branch.assignment)) {
      add('this branch\'s assignment could not be read, so its coverage was not checked here. ' +
        'The server still checks it; if this persists the connector is older than the assignment format.');
    }
    return;
  }

  const metadata = output.test_metadata as Record<string, unknown> | undefined;
  const entries = Array.isArray(metadata?.capabilities) ? metadata.capabilities : null;
  if (!entries) {
    add('test_metadata must carry a capabilities array, one entry per assigned id.');
    return;
  }

  const byId = new Map(assigned.map((entry) => [entry.id, entry]));
  const idKey = idKeyOf(branch.assignment, assigned);
  const seen = new Map<string, number>();
  const suiteText = suiteBytes(output);

  for (const entry of entries) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const id = String(idKey ? row[idKey] ?? '' : '');
    const expected = byId.get(id);
    if (!expected) {
      add(`test_metadata names "${id || '(no id)'}", which is not in this branch's assignment.`);
      continue;
    }
    seen.set(id, (seen.get(id) ?? 0) + 1);
    checkOneCase(row, id, expected, suiteText, add);
  }

  for (const [id, count] of seen) {
    if (count > 1) add(`${id} is answered ${count} times — every assigned id is answered exactly once.`);
  }

  const missing = assigned.filter((entry) => !seen.has(entry.id)).map((entry) => entry.id).sort();
  if (missing.length > 0) {
    add(`no answer for ${missing.length} assigned id(s): ${missing.join(', ')}.`);
  }
}

function checkOneCase(
  row: Record<string, unknown>,
  id: string,
  expected: AssignedCase,
  suiteText: string,
  add: (message: string) => void,
): void {
  const status = String(row.status ?? '');

  if (status === 'unguarded') {
    if (!String(row.reason ?? '').trim()) {
      add(`${id} is unguarded but gives no business reason for it.`);
    }
    return;
  }

  if (status !== 'covered') {
    add(`${id} must be answered "covered" or "unguarded" (got ${JSON.stringify(status)}).`);
    return;
  }

  if (String(row.contract_key ?? '') !== expected.contract_key) {
    add(`${id} carries contract_key ${JSON.stringify(row.contract_key)} — it must be copied verbatim as "${expected.contract_key}".`);
  }
  if (String(row.case_marker ?? '') !== expected.case_marker) {
    add(`${id} carries case_marker ${JSON.stringify(row.case_marker)} — it must be copied verbatim as "${expected.case_marker}". Markers are never minted or edited locally.`);
    return;
  }

  // Declared covered, but the marker never made it into a test name or a
  // Gherkin tag. The server refuses this, and rightly: without the marker in the
  // suite there is nothing to join a result to, so the capability would report
  // as a mismatch rather than as the green it claims.
  if (suiteText && !suiteText.includes(expected.case_marker)) {
    add(`${id} is answered "covered", but its marker ${expected.case_marker} appears nowhere in the suite files.`);
    return;
  }

  checkSurfaceCoverage(row, id, expected, suiteText, add);
}

// Which scenario reached which address. The a2time run of 2026-08-04 published
// 97 coverage rows against 99 Scenarios: one Scenario had no row, another had a
// row naming no address. Both mean the same thing — a Scenario that ran and
// whose result reaches nothing on the map — and both were found by the
// independent reviewer, hours later, doing a different job. This check was the
// cheap place to find them and it was not looking.
//
// Only asked when the answer is already speaking this language: an answer with
// no `surface_coverage` anywhere is an older map's shape, and refusing it here
// would refuse what the server accepts. Within a branch that does declare it,
// the rules below are the server's own, in the server's own order.
function checkSurfaceCoverage(
  row: Record<string, unknown>,
  id: string,
  expected: AssignedCase,
  suiteText: string,
  add: (message: string) => void,
): void {
  if (expected.surfaces.length === 0) return;
  const coverage = row.surface_coverage;
  if (coverage === undefined) return; // not this map's shape — the server decides

  if (!Array.isArray(coverage)) {
    add(`${id} is answered "covered", so its surface_coverage must be an array of {scenario, surfaces}.`);
    return;
  }

  const named = new Set<string>();
  const reached = new Set<string>();
  for (const [index, item] of coverage.entries()) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const scenario = String(entry.scenario ?? '').trim();
    const surfaces = entry.surfaces;
    if (!scenario || !Array.isArray(surfaces)) {
      add(`${id} surface_coverage[${index}] must name a scenario and its surfaces.`);
      continue;
    }
    if (surfaces.length === 0) {
      add(`${id} surface_coverage names no surface for "${scenario}" — that scenario's result reaches nothing on the map.`);
    }
    if (suiteText && !suiteText.includes(scenario)) {
      add(`${id} surface_coverage names "${scenario}", which appears nowhere in the suite files.`);
    }
    named.add(scenario);
    surfaces.filter((s): s is string => typeof s === 'string').forEach((s) => reached.add(s));
  }

  // Spec 34, decision 15: an address the suite genuinely cannot drive — a
  // third-party OAuth callback, a vendor webhook — is declared rather than
  // faked, and satisfies coverage without being claimed as reached. Mirrored
  // here in the server's own shape; refusing it locally would refuse an answer
  // the server takes, which is the one direction of drift that costs a branch.
  const declaredUnreachable = collectUnreachable(row, id, reached, add);

  const missed = expected.surfaces.filter(
    (surface) => !reached.has(surface) && !declaredUnreachable.has(surface),
  );
  if (missed.length > 0) {
    add(
      `${id} surface_coverage accounts for no scenario at ${missed.join(', ')}` +
        ' — drive it, or declare it unreachable with a business reason.',
    );
  }
  // No check here for "declares everything unreachable and drives nothing": the
  // caller already returned when the capability's marker appears in no suite
  // file, so a capability with no Scenario never reaches this function at all.
  // The server refuses that state for the same reason, one rule earlier.
  const foreign = [...reached, ...declaredUnreachable].filter(
    (surface) => !expected.surfaces.includes(surface),
  );
  if (foreign.length > 0) {
    add(`${id} surface_coverage names ${foreign.join(', ')}, which this branch's assignment does not carry.`);
  }

  // The other direction, and the one that found nothing on a2time because
  // nobody asked it: a Scenario that carries the marker but appears in no row.
  //
  // Read off the file rather than parsed: a tag line carrying this marker, then
  // the next line that has a colon in it, whose name is whatever follows the
  // first colon. That holds for any Gherkin dialect, because only the keyword is
  // translated and the colon is not. When the shape is not recognised the answer
  // is silence — the server does parse this properly, and a guess here that says
  // "you forgot a Scenario" about a Scenario that does not exist would cost the
  // branch its publication.
  const unlisted = scenarioNamesTagged(suiteText, expected.case_marker).filter((name) => !named.has(name));
  if (unlisted.length > 0) {
    add(`${id} surface_coverage does not account for ${unlisted.map((n) => `"${n}"`).join(', ')}.`);
  }
}

// The addresses this capability says it cannot drive, each with its own reason.
// A blanket reason covering a list is exactly the boilerplate the rule exists to
// stop, so the reason is per address and its absence is the whole complaint.
function collectUnreachable(
  row: Record<string, unknown>,
  id: string,
  reached: Set<string>,
  add: (message: string) => void,
): Set<string> {
  const declared = row.unreachable_surfaces;
  if (declared === undefined) return new Set();

  if (!Array.isArray(declared) || declared.length === 0) {
    add(`${id} unreachable_surfaces must be a non-empty array of {surface, reason} when it is present.`);
    return new Set();
  }

  const surfaces = new Set<string>();
  for (const [index, item] of declared.entries()) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const surface = String(entry.surface ?? '').trim();
    if (!surface) {
      add(`${id} unreachable_surfaces[${index}] names no surface.`);
      continue;
    }
    if (!String(entry.reason ?? '').trim()) {
      add(`${id} declares ${surface} unreachable but gives no business reason for it.`);
      continue;
    }
    if (reached.has(surface)) {
      add(`${id} both drives ${surface} in a scenario and declares it unreachable — it is one or the other.`);
      continue;
    }
    if (surfaces.has(surface)) {
      add(`${id} declares ${surface} unreachable more than once.`);
      continue;
    }
    surfaces.add(surface);
  }
  return surfaces;
}

// Scenario names carrying one marker, by shape rather than by grammar. See the
// caller for why this stays deliberately timid.
function scenarioNamesTagged(suiteText: string, marker: string): string[] {
  if (!suiteText) return [];

  const lines = suiteText.split('\n');
  const names: string[] = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('@') || !trimmed.split(/\s+/).includes(`@${marker}`)) continue;

    const next = lines.slice(index + 1).find((candidate) => candidate.trim().length > 0) ?? '';
    const colon = next.indexOf(':');
    if (colon === -1) continue;

    const name = next.slice(colon + 1).trim();
    if (name) names.push(name);
  }
  return names;
}

// Which field names the id. Read off the *assignment*, where the answer is
// exact: the id is already known (it is `contract_key` minus its prefix), so the
// field holding it can be identified rather than guessed.
//
// An earlier version searched the host's answer for any string field whose value
// happened to be an assigned id. That usually landed on the right key and could
// just as well have landed on a `headline` that echoed the id. Neither branch's
// key name is written down here either way — `interface_id` and `capability_id`
// stay the server's business.
function idKeyOf(assignment: unknown, cases: AssignedCase[]): string | null {
  const ids = new Set(cases.map((entry) => entry.id));
  let found: string | null = null;

  const walk = (value: unknown): void => {
    if (found) return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;

    const row = value as Record<string, unknown>;
    if (typeof row.contract_key === 'string') {
      const id = row.contract_key.slice(CONTRACT_PREFIX.length);
      for (const [key, candidate] of Object.entries(row)) {
        if (key !== 'contract_key' && candidate === id && ids.has(id)) { found = key; return; }
      }
    }
    Object.values(row).forEach(walk);
  };

  walk(assignment);
  return found;
}

// Does the assignment carry anything at all? Distinguishes "nothing to guard"
// from "we could not read what was there".
function hasContent(assignment: unknown): boolean {
  if (Array.isArray(assignment)) return assignment.length > 0;
  if (!assignment || typeof assignment !== 'object') return false;
  return Object.values(assignment as Record<string, unknown>).some(hasContent);
}

// The assignment is an opaque body the server composed, so it is walked rather
// than destructured: every object carrying a `contract_key` is one assigned
// case, wherever the shape happens to nest it.
function assignedCases(assignment: unknown): AssignedCase[] {
  const found: AssignedCase[] = [];

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;

    const row = value as Record<string, unknown>;
    const key = row.contract_key;
    const marker = row.case_marker;
    if (typeof key === 'string' && key.startsWith(CONTRACT_PREFIX) && typeof marker === 'string') {
      found.push({
        id: key.slice(CONTRACT_PREFIX.length),
        contract_key: key,
        case_marker: marker,
        // Only the behavioral assignment carries addresses. Its absence is what
        // tells the coverage check below there is nothing of that kind here.
        surfaces: Array.isArray(row.surfaces) ? row.surfaces.filter((s): s is string => typeof s === 'string') : [],
      });
    }
    Object.values(row).forEach(walk);
  };

  walk(assignment);
  return found;
}

// Every byte of the branch's suite, main file and support files together, for
// the "is the marker actually in there" check.
function suiteBytes(output: HostBranchOutput): string {
  const file = output.suite_file as
    | { content?: unknown; support_files?: { content?: unknown }[] }
    | undefined;
  if (!file) return '';

  return [file.content, ...(Array.isArray(file.support_files) ? file.support_files.map((f) => f.content) : [])]
    .filter((content): content is string => typeof content === 'string')
    .join('\n');
}

function sameJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// Reads the task and the answer and reports every problem it can see. Reading
// the answer is itself a check — safe paths, files that exist, a parseable
// envelope — and it is done branch by branch, so a bad entry in one contributes
// its problem and the other is still examined. Only the answer file as a whole
// can stop the pass, because then there is no document left to read.
export function validateBuildProblems(config: Config): BuildProblem[] {
  const request = readSuiteBuildRequest(config.projectRoot);
  const { outputs, unreadable } = readHostSuiteOutputsPerBranch(request.output_path, request);

  return [
    ...unreadable.map((entry) => ({ branch: entry.suite_kind, message: entry.message })),
    ...collectBuildProblems(request, outputs, unreadable),
  ];
}

// One branch's problems, for the line that reports it unpublished alongside its
// peer. `put-suite-build` blocks per branch, so its message is per branch too.
export function formatBranchProblems(messages: string[]): string {
  if (messages.length === 1) return messages[0];

  return `${messages.length} problems in this branch's answer:\n${messages.map((m) => `      - ${m}`).join('\n')}`;
}

// One report, not a queue of one-at-a-time discoveries. Fixing one thing to be
// told the next costs a full round trip each time, and the round trip is the
// expensive part.
export function formatProblems(problems: BuildProblem[]): string {
  const lines = problems.map((problem) => `  ${problem.branch}: ${problem.message}`);
  return (
    `Your suite answer has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n` +
    `${lines.join('\n')}\n` +
    'Fix all of them, then answer again. The Unitbob server has the last word on ' +
    'what it accepts; this check just finds the common problems in seconds instead ' +
    'of after the whole build.\n'
  );
}

export async function validateBuild(
  config: Config,
  _args: string[] = [],
  deps?: { stdout?: { write: (chunk: string) => unknown } },
): Promise<void> {
  const stdout = deps?.stdout ?? process.stdout;
  const problems = validateBuildProblems(config);

  if (problems.length === 0) {
    stdout.write('Your suite answer looks well-formed. Run `unitbob put-suite-build` to publish it.\n');
    return;
  }
  throw new Error(formatProblems(problems));
}
