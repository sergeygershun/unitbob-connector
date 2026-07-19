import { existsSync, readFileSync } from 'node:fs';
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
