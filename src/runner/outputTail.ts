import type { RunnerResult } from './types.ts';

// The end of what a run printed, stderr first: enough to see why a runner
// died, not the whole log. One place for the three verbs that print it
// (`check`, `run-local`, `put-tests`); `run-local` asks for more because the
// person is reading it in a loop, `check` files it into a suite error.
export function outputTail(result: RunnerResult, limit: number): string {
  const bits: string[] = [];
  if (result.stderr.trim()) bits.push(result.stderr.trim());
  if (result.stdout.trim()) bits.push(result.stdout.trim());
  const joined = bits.join('\n');
  return joined.length > limit ? joined.slice(-limit) : joined;
}
