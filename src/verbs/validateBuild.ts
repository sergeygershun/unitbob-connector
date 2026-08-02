import type { Config } from '../config.ts';
import {
  readHostSuiteOutputs,
  readSuiteBuildRequest,
  type HostBranchOutput,
  type SuiteBuildBranch,
  type SuiteBuildRequest,
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
}

export function collectBuildProblems(
  request: SuiteBuildRequest,
  outputs: HostBranchOutput[],
): BuildProblem[] {
  const problems: BuildProblem[] = [];
  const branchFor = new Map(request.branches.map((branch) => [branch.suite_kind, branch]));

  for (const output of outputs) {
    // The host said plainly that it could not build this one. That is an answer,
    // not a malformed answer, and the server records it as such.
    if (output.build_error) continue;

    const branch = branchFor.get(output.suite_kind);
    if (!branch) continue; // readHostSuiteOutputs already refused this one

    const add = (message: string): void => { problems.push({ branch: output.suite_kind, message }); };
    checkRunnerManifest(branch, output, add);
    checkAssignment(branch, output, add);
  }

  return problems;
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
  if (assigned.length === 0) return; // nothing was assigned; nothing to account for

  const metadata = output.test_metadata as Record<string, unknown> | undefined;
  const entries = Array.isArray(metadata?.capabilities) ? metadata.capabilities : null;
  if (!entries) {
    add('test_metadata must carry a capabilities array, one entry per assigned id.');
    return;
  }

  const byId = new Map(assigned.map((entry) => [entry.id, entry]));
  const idKey = idKeyOf(entries, byId);
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
  }
}

// Which field of an answer entry names the id. Learned from the data rather
// than hard-coded, so neither branch's id key is written down here: it is
// whichever field carries a value the assignment issued.
function idKeyOf(entries: unknown[], byId: Map<string, AssignedCase>): string | null {
  for (const entry of entries) {
    const row = (entry ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string' && byId.has(value)) return key;
    }
  }
  return null;
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
      found.push({ id: key.slice(CONTRACT_PREFIX.length), contract_key: key, case_marker: marker });
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

// Reads the task and the answer and reports every problem it can see. Both
// halves matter: reading the answer is itself a check (safe paths, files that
// exist, a parseable envelope), and it stops at the first problem because a
// malformed answer file has no second problem to find — there is no document to
// go on reading.
export function validateBuildProblems(config: Config): BuildProblem[] {
  const request = readSuiteBuildRequest(config.projectRoot);
  const outputs = readHostSuiteOutputs(request.output_path, request);
  return collectBuildProblems(request, outputs);
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
