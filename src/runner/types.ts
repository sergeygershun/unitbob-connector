import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { ProcResult } from '../proc.ts';

// What every built-in runner strategy hands back: the raw process result, the
// exact command it ran (for structured error payloads), the project-relative
// path it expected the machine-readable report at, and that report read back
// verbatim (empty when the run produced none — e.g. the suite failed to boot).
export interface RunnerResult extends ProcResult {
  command: string;
  args: string[];
  resultPath: string;
  report: string;
}

// Read a report file back verbatim. A missing or unreadable file is a clean
// empty string, not a throw: the caller reports a structured suite error.
export function readReport(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

// Clear the report before a run, and hand back whatever survived the attempt
// (spec 36, criterion 9).
//
// The report is written to a fixed path with no run marker on it, and — once the
// run happens in a container — into a folder both sides share. A run we gave up
// on can leave a process alive inside that container, and that process finishes
// and writes the report after we stopped waiting. The next run would then read a
// file belonging to a run nobody watched, and report a green result nobody
// earned. Having no result at all is the better of the two.
//
// What comes back is the modification time of a file that would not delete —
// a read-only mount, a permission we do not have — so the read below can tell
// "the same file, still there" from "a new one the run just wrote". Nothing is
// compared against this machine's clock: both stamps come from whoever wrote the
// file, so a container whose clock differs from the host's cannot make a good
// report look stale.
export function clearReport(path: string): number | null {
  try {
    rmSync(path, { force: true });
  } catch {
    // Could not remove it. That is exactly the case the stamp below covers.
  }

  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// The report of *this* run, or nothing. `survivor` is what `clearReport`
// returned before the run started.
export function readFreshReport(path: string, survivor: number | null): string {
  if (survivor !== null) {
    try {
      if (statSync(path).mtimeMs === survivor) return '';
    } catch {
      return '';
    }
  }
  return readReport(path);
}
