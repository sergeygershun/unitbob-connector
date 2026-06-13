// Spawn helper for the local tools the connector drives (graphify, rspec). It
// captures stdout/stderr/exit code and hands them back untouched — shaping or
// interpreting that output is the caller's (and ultimately Rails') job.
import { spawn } from 'node:child_process';

export interface ProcResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runProcess(
  command: string,
  args: string[] = [],
  options: { cwd?: string } = {},
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}
