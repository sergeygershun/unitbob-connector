import { readPacketIndex, type PacketTarget } from './packets.ts';

// Spec 37-3, criterion 1. How wide a branch's fan-out should be.
//
// The rule this replaces said there was no ceiling at all: "an agent re-reads
// its context every turn, so splitting the work never costs more than keeping it
// together." Half right, and the wrong half was load-bearing. An agent's cost is
// the sum of its context over its turns, so splitting pulls in two directions:
//
//   - the opening context is bought once per worker and re-read every turn, so
//     it multiplies with the width. 26,065 tokens on the bench of 2026-08-24,
//     the same to within ±370 across fifteen workers.
//   - each worker's conversation is shorter, and a conversation's cost grows
//     with the square of its length, so this falls with the width.
//
// There is therefore a minimum, and it is neither end. Measured on that bench,
// against what the fifteen workers actually cost:
//
//   workers     1      2      3      5      8     15     20
//   input   51.2M  34.6M  29.9M  27.7M  28.8M  35.6M  41.3M
//
// Fifteen was 28% over the cheapest width. One worker — which is what "the work
// fits in one context" would have said, and what the first draft of this rule
// enforced — is 85% over it, and would have run a 216-turn worker into a
// 150-turn fuse. The floor is as expensive a mistake as the ceiling.
//
// See ai/specs/37-3-fan-out-by-workload/after-2026-08-24.md in the brain repo.

// What the optimum is not a function of. Productive turns per 1,000 tokens of
// source were 7.8 on the behavioral branch and 1.4 on the structural one of the
// same run — 5.6× apart — and per assigned id, 8× apart. Bytes measure how much
// there is to read, which turns out not to be what a worker spends its turns on.
// They stay here for the printout and for the record in `fan_out`; they do not
// set the width.
const BYTES_PER_TOKEN = 4;
const WRITTEN_PER_READ = 3;

// What it is a function of. A planned case is one intent the worker has to turn
// into a written example or Scenario, and its cost in turns is a property of the
// branch, not of the project: a Gherkin Scenario needs the World, a session, a
// fixture and an assertion; a structural example calls a method.
//
// Measured 2026-08-24: 35 behavioral cases over 126 productive turns, 91
// structural cases over 65.
const TURNS_PER_CASE: Record<string, number> = { behavioral: 3.6, structural: 0.7 };

// The optimum width is the branch's productive turns over this. It comes out of
// setting the derivative of the cost above to zero, which gives
// `sqrt(2·warmup·preamble/added + warmup²)` — 31.3 on the behavioral branch of
// that run and 41.7 on the structural one, near enough to each other that one
// number carries both and the flat bottom of the curve absorbs the difference.
const TURNS_PER_WORKER = 36;

// What a worker spends before it writes anything — reading its packets, its plan
// item and its seeded facts. Measured 2026-08-24: 176 warm-up turns over eight
// behavioral workers, 202 over seven structural ones. It is per worker and does
// not divide, which is half of why width costs; it is added back here so that
// the turns this prints are the whole conversation, the thing that meets the
// 150-turn fuse.
const WARMUP_TURNS: Record<string, number> = { behavioral: 22, structural: 28 };

// Every case ends up at the same handful of widths, so the rule has to be a band
// rather than a number: anywhere from three to eight workers cost within 10% of
// the cheapest on the measured run. What the band excludes is what actually
// costs — fifteen at one end, one at the other.
const NARROWEST = 0.5;
const WIDEST = 1.5;

export interface BranchWidth {
  branch: string;
  planned_cases: number;
  // Turns one worker of this branch is expected to spend, at the chosen width.
  turns_each: number;
  workers: number;
  fewest: number;
  most: number;
}

// How wide a branch should be, from the cases its plan intends to write.
// Returns nothing for a branch this connector has no measured cost for: a rule
// with no measurement behind it must not refuse anybody's plan.
export function branchWidth(branch: string, plannedCases: number): BranchWidth | undefined {
  const perCase = TURNS_PER_CASE[branch];
  if (perCase === undefined || plannedCases <= 0) return undefined;
  const turns = plannedCases * perCase;
  const workers = Math.max(1, Math.round(turns / TURNS_PER_WORKER));
  return {
    branch,
    planned_cases: plannedCases,
    turns_each: Math.round(turns / workers) + (WARMUP_TURNS[branch] ?? 0),
    workers,
    fewest: Math.max(1, Math.round(workers * NARROWEST)),
    most: Math.max(1, Math.ceil(workers * WIDEST)),
  };
}

export interface BranchWorkload {
  branch: string;
  // Distinct source files, so two entrypoints in one file are one read.
  files: number;
  bytes: number;
  // Entrypoints whose file nothing measured, priced at what the others average.
  unmeasured: number;
  read_tokens: number;
  work_tokens: number;
}

// What each branch's source weighs. Kept because it is the honest answer to "how
// much is there", printed before the plan exists and recorded in `fan_out` — but
// it is not what decides the width. See TURNS_PER_CASE above.
//
// `taken` narrows the count to the ids a plan actually took, which matters since
// criterion 2 let the structural branch be narrowed too: the packets are built
// from the whole assignment, before anybody chose a scope.
export function branchWorkloads(
  projectRoot: string,
  taken?: Map<string, Set<string>>,
): BranchWorkload[] {
  const index = readPacketIndex(projectRoot);
  if (!index || index.targets.length === 0) return [];

  const measured = new Map<string, Map<string, number>>();
  const unmeasured = new Map<string, number>();
  for (const target of index.targets) {
    const ids = taken?.get(target.branch);
    if (taken && !ids?.has(target.id)) continue;
    const size = sizeOf(target);
    // A file too large to copy still has a path and a size, and it is the
    // heaviest reading on the branch — counting it as nothing would let the
    // biggest sources look like the smallest.
    const file = target.packet ?? target.source_file;
    if (file !== undefined && size !== undefined) {
      const files = measured.get(target.branch) ?? new Map<string, number>();
      files.set(file, size);
      measured.set(target.branch, files);
    } else {
      unmeasured.set(target.branch, (unmeasured.get(target.branch) ?? 0) + 1);
    }
  }

  const branches = new Set([...measured.keys(), ...unmeasured.keys()]);
  return [...branches].sort().flatMap((branch) => {
    const files = measured.get(branch);
    if (!files || files.size === 0) return [];
    const bytes = [...files.values()].reduce((sum, size) => sum + size, 0);
    const missing = unmeasured.get(branch) ?? 0;
    const withMissing = bytes + Math.round((bytes / files.size) * missing);
    const read_tokens = Math.round(withMissing / BYTES_PER_TOKEN);
    return [{
      branch, files: files.size, bytes, unmeasured: missing,
      read_tokens, work_tokens: read_tokens * (1 + WRITTEN_PER_READ),
    }];
  });
}

// The index is a file on the vibecoder's disk, so a size that is not a real byte
// count is treated as a size we do not have rather than as zero. Zero would
// quietly shrink the branch's average.
function sizeOf(target: PacketTarget): number | undefined {
  const { bytes } = target;
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
}

export function widthLine(width: BranchWidth): string {
  return (
    `  ${width.branch} — ${width.planned_cases} planned ` +
    `${width.planned_cases === 1 ? 'case' : 'cases'}: ${width.workers} ` +
    `${width.workers === 1 ? 'worker' : 'workers'} of about ${width.turns_each} turns each ` +
    `(${width.fewest}–${width.most} accepted).\n`
  );
}

export function workloadLine(load: BranchWorkload): string {
  const missing = load.unmeasured === 0
    ? ''
    : ` plus ${load.unmeasured} ${load.unmeasured === 1 ? 'entrypoint' : 'entrypoints'} nothing resolved, ` +
      'priced at what the others average';
  return (
    `  ${load.branch} — ${load.files} ${load.files === 1 ? 'file' : 'files'}, ` +
    `${load.bytes.toLocaleString('en-US')} bytes${missing}: ` +
    `${load.read_tokens.toLocaleString('en-US')} tokens to read and about ` +
    `${(load.work_tokens - load.read_tokens).toLocaleString('en-US')} to write.\n`
  );
}
