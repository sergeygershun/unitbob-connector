import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Spec 34-2, criterion 5. Neither the number of subagents nor the number of
// rounds had a ceiling, and both were left to the recipe to hold. On the
// autobrella run of 2026-08-06 that failed in the most ordinary way available:
// the recipe is 35 793 characters, and it was its last third that did not hold —
// one agent took 63 capabilities and 514 surfaces in a single pass and said so
// itself, that the last ~34 were written "under time pressure without reading
// the sources".
//
// So the numbers travel in the request instead, where the host reads them on its
// very first step along with everything else it was handed, rather than in a
// sentence two thirds of the way down a recipe.
//
// Where each number comes from — the measurements are in the spec's "Откуда
// цифры", and none of these is a round guess:
//
// - `workers: 4` — the fan was standing on review, where the work is mechanical,
//   and missing from generation, where the work is reading code. It moves.
// - `review_rounds: 2` — three rounds on a2time were expensive because of the
//   number of reviewers, not rounds: 5 slices x 3 rounds = 15 launches. With one
//   reviewer (criterion 6), two rounds is two launches — seven times cheaper
//   than what has already been lived through.
// - `repair_rounds: 8` — both real logs show 3-5 runs of a branch as ordinary
//   work, so 8 has room. The ceiling is not only about money: the recipe forbids
//   weakening a check to get green, and that is the rule that breaks in the
//   polishing loop, where the fifth "why is it red again" makes bending the
//   expectation most tempting.
export interface RunBudget {
  workers: number;
  review_rounds: number;
  repair_rounds: number;
}

export const RUN_BUDGET: RunBudget = { workers: 4, review_rounds: 2, repair_rounds: 8 };

// Only two of the three have a counter behind them. The connector cannot see
// the host launch a subagent, so `workers` is a number it states and cannot
// check. It travels in the same block anyway, and the recipe is told not to sort
// the fields into checked and unchecked: an agent that knows which half is
// watched has been handed a reason to treat the other half as advice.
const SPENT_FILE = 'budget-spent.json';

function spentPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', SPENT_FILE);
}

// On disk, not in memory, because the loop these bound spans separate processes:
// every `run-local` and every `suite-review-prepare` is a fresh `npx`. A count
// held in a running command would reset on each one and bound nothing.
export function spend(projectRoot: string, key: string): number {
  const path = spentPath(projectRoot);
  const spent = readSpent(path);
  const count = (spent[key] ?? 0) + 1;
  spent[key] = count;
  mkdirSync(dirname(path), { recursive: true });
  // Written whole and moved into place, never written in place. A plain write
  // that is interrupted leaves truncated JSON, which `readSpent` then reads as
  // nothing spent — so the count would reset exactly when a run is being killed
  // and restarted, which is the loop this exists to bound.
  const staging = `${path}.tmp`;
  writeFileSync(staging, `${JSON.stringify(spent, null, 2)}\n`);
  renameSync(staging, path);
  return count;
}

// A new build request starts on a fresh budget. Without this a project Unitbob
// ran a month ago opens today already over its ceiling, and every command
// announces the last round — noise, and advice that is wrong besides.
//
// True when there was something to clear, so the caller can say so out loud.
// Re-running `suite-prepare` is a documented step of the loop, and it resets
// both counters; a reset nobody is told about is a ceiling that quietly is not
// one.
export function clearSpending(projectRoot: string): boolean {
  const path = spentPath(projectRoot);
  const had = existsSync(path);
  rmSync(path, { force: true });
  return had;
}

// A damaged or hand-edited file counts as nothing spent. The alternative is
// refusing to run over a bookkeeping file, which would make a counter that
// deliberately never blocks into the one thing that does.
function readSpent(path: string): Record<string, number> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'number' && Number.isFinite(value)),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

// A request written by an older connector carries no budget, and that is not an
// error: there is no ceiling to enforce, so every counter goes quiet and the run
// works as it did before (spec 34-2, edge cases).
export function readBudget(value: unknown): RunBudget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const block = value as Record<string, unknown>;
  const fields = (['workers', 'review_rounds', 'repair_rounds'] as const)
    .map((field) => [field, block[field]] as const);
  if (fields.some(([, number]) => typeof number !== 'number' || !Number.isFinite(number))) return undefined;
  return Object.fromEntries(fields) as unknown as RunBudget;
}
