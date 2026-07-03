// Spawn helper for the local tools the connector drives (graphify, rspec). It
// captures stdout/stderr/exit code and hands them back untouched — shaping or
// interpreting that output is the caller's (and ultimately Rails') job.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ProcResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export const GRAPHIFY_TIMEOUT_MS = 10 * 60 * 1000;

export function runProcess(
  command: string,
  args: string[] = [],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env });
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    const finish = (result: ProcResult): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stderr += `${stderr.endsWith('\n') || stderr.length === 0 ? '' : '\n'}${command} timed out after ${options.timeoutMs}ms`;
          child.kill('SIGTERM');
          forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
        }, options.timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(err);
    });
    child.on('close', (code) => finish({ stdout, stderr, code: timedOut ? null : code }));
  });
}

export async function requireGraphify(): Promise<void> {
  try {
    const result = await runProcess('graphify', ['--help']);
    if (result.code === 0) return;
    throw new Error(result.stderr.trim() || result.stdout.trim() || `graphify --help exited ${result.code}`);
  } catch (err) {
    throw new Error(
      `graphify is required but was not found or did not run. Install it with ` +
        `\`pip install graphifyy && graphify install\` (PyPI package "graphifyy", command ` +
        `"graphify", needs Python 3.10+), then retry (${(err as Error).message}).`,
    );
  }
}

export function ensureUnitbobIgnored(projectRoot: string): void {
  ensureLine(join(projectRoot, '.gitignore'), '.unitbob/');
  ensureLine(join(projectRoot, '.gitignore'), 'graphify-out/');
  ensureLine(join(projectRoot, '.graphifyignore'), '.unitbob/');
}

function ensureLine(path: string, line: string): void {
  let current = '';
  if (existsSync(path)) {
    current = readFileSync(path, 'utf8');
    if (current.split('\n').some((existing) => existing.trim() === line)) return;
  }

  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${current}${prefix}${line}\n`);
}

export async function runGraphifyExtractKeyless(projectRoot: string): Promise<ProcResult> {
  // Deterministic AST-only graph; no LLM, no API key. `update --force` re-extracts
  // the code and refreshes <root>/graphify-out/graph.json in place, replacing
  // removed nodes. Semantic enrichment, if wanted, is host-LLM work (the
  // /graphify skill on the client), never a keyed LLM here.
  return await runProcess(
    'graphify',
    ['update', projectRoot, '--force'],
    { cwd: projectRoot, timeoutMs: GRAPHIFY_TIMEOUT_MS },
  );
}
