import { readPacketIndex, type PacketTarget } from './packets.ts';

// Spec 37-3, criterion 1. How wide a branch's fan-out may be, decided by the
// size of the work rather than by how many items the map happens to list.
//
// The old rule said there was no ceiling at all: "an agent re-reads its context
// every turn, so splitting the work never costs more than keeping it together."
// That is true of the work and false of everything else a worker carries. A
// worker's opening context — its role, its recipe, its plan item — is 26,065
// tokens on the bench of 2026-08-24, and it varies by ±370 across fifteen
// workers. It is not divided between them; it is bought once per worker and
// re-read every turn. Fifteen workers is 391,000 tokens of it, to carry 39,652
// tokens of actual work.
//
// Every number below is measured on that bench, never chosen. See
// ai/specs/37-3-fan-out-by-workload/after-2026-08-24.md in the brain repo.

// Four bytes to the token, the ratio the bench keeps returning: 281,803
// characters of microblog source came to about 70,000 tokens.
const BYTES_PER_TOKEN = 4;

// The context a worker is allowed to reach. Same number as MAX_WORKER_CONTEXT
// in the brain's script/cost/run_cost.py, which is the only thing that checks it
// after the fact; the two must not drift. Criterion 4 leaves the value itself
// open — it wants a second bench, on an application far larger than microblog,
// before anybody moves it — so this rule inherits whatever that number becomes.
const WORKER_CONTEXT_CEILING = 400_000;

// The largest context any worker reached on the bench: 115,937, while carrying
// about 2,600 tokens of work. Work is not what fills a worker — a least-squares
// fit of peak against work across the fifteen has an R² of 0.009, so work
// explains under one percent of why one worker's context differs from another's.
// That is the finding, and it is why this is the whole fixed cost rather than
// a slope: a worker costs what a worker costs, and the work rides along.
const WORKER_PEAK_WITHOUT_WORK = 115_937;

// Work is read plus written, and only the read half can be measured before the
// plan exists. On the same bench the workers wrote 29,836 tokens against 9,816
// tokens of packets — almost exactly three to one — so the written half is
// estimated from the read half rather than left out of the sum.
const WRITTEN_PER_READ = 3;

// How much work one worker may carry: what the biggest measured worker left
// unused under the ceiling. 400,000 − 115,937.
export const WORK_PER_WORKER_TOKENS = WORKER_CONTEXT_CEILING - WORKER_PEAK_WITHOUT_WORK;

export interface BranchWorkload {
  branch: string;
  // Distinct source files, so two entrypoints in one file are one read. Sharing
  // is the common case and double-counting it would invent work that is not
  // there.
  files: number;
  bytes: number;
  // Entrypoints whose file nothing measured. They are not free — they are the
  // most expensive kind of work there is, because that worker searches — so
  // they are counted at what the branch's measured files average.
  unmeasured: number;
  read_tokens: number;
  work_tokens: number;
  workers: number;
}

// What each branch's work weighs, from the packets already on disk.
//
// `taken` narrows the count to the ids a plan actually took, which matters since
// criterion 2 let the structural branch be narrowed too: the packets are built
// from the whole assignment, before anybody chose a scope, so measuring all of
// them against the width of a narrowed plan would compare two different jobs.
// Omit it before the plan exists, and the answer is the whole assignment.
//
// A branch nothing could be measured for is left out entirely: a rule with no
// measurement behind it must not refuse anybody's plan.
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
    // Keyed by the file, so the same file behind two entrypoints is one read.
    // A file too large to copy still has a path and a size, and it is the
    // heaviest work on the branch — counting it as nothing would let the
    // biggest sources argue for the fewest workers.
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
    // Nothing on this branch resolved to a file with a size, so there is no
    // average to price the rest at and nothing to divide. Ungated.
    if (!files || files.size === 0) return [];
    const bytes = [...files.values()].reduce((sum, size) => sum + size, 0);
    const missing = unmeasured.get(branch) ?? 0;
    const withMissing = bytes + Math.round((bytes / files.size) * missing);
    const read_tokens = Math.round(withMissing / BYTES_PER_TOKEN);
    const work_tokens = read_tokens * (1 + WRITTEN_PER_READ);
    return [{
      branch, files: files.size, bytes, unmeasured: missing,
      read_tokens, work_tokens, workers: workersFor(work_tokens),
    }];
  });
}

// The index is a file on the vibecoder's disk and is read defensively
// everywhere else, so a size that is not a real byte count is treated as a size
// we do not have rather than as zero. Zero would quietly shrink the branch's
// average and tighten a ceiling nobody could see move.
function sizeOf(target: PacketTarget): number | undefined {
  const { bytes } = target;
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
}

// Never zero, and never more than the work needs. One worker is the answer
// whenever the work fits in one, and that is not a preference: splitting work
// that already fits buys another whole opening context and divides nothing.
export function workersFor(workTokens: number): number {
  if (!Number.isFinite(workTokens) || workTokens <= 0) return 1;
  return Math.max(1, Math.ceil(workTokens / WORK_PER_WORKER_TOKENS));
}

// The sentence that goes wherever this number is printed. It names what the
// number came from, because a ceiling nobody can trace is a ceiling somebody
// will route around.
export function workloadLine(load: BranchWorkload): string {
  const missing = load.unmeasured === 0
    ? ''
    : ` plus ${load.unmeasured} ${load.unmeasured === 1 ? 'entrypoint' : 'entrypoints'} nothing resolved, ` +
      'priced at what the others average';
  return (
    `  ${load.branch} — ${load.files} ${load.files === 1 ? 'file' : 'files'}, ` +
    `${load.bytes.toLocaleString('en-US')} bytes${missing}: ` +
    `${load.read_tokens.toLocaleString('en-US')} tokens to read and about ` +
    `${(load.work_tokens - load.read_tokens).toLocaleString('en-US')} to write, ` +
    `${load.work_tokens.toLocaleString('en-US')} of work — ` +
    `${load.workers} ${load.workers === 1 ? 'worker' : 'workers'}.\n`
  );
}
