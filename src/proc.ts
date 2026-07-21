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

// Paths that hold no business logic in the stacks unitbob supports — Rails,
// JS/TS, Python — and that graphify does not already skip (it drops
// node_modules, venv, dist, build, target, out, __pycache__, and the framework
// cache and report dirs on its own).
//
// Every entry earns its place, because an over-broad pattern fails silently: a
// subsystem simply never appears on the map and nobody learns why. Measured on
// one real Rails app (2943 nodes), vendor/ was 1337 of them, app/assets/ 414,
// db/migrate/ 314 — 70% of the graph, and the busiest nodes in it were `_()`
// and `$()`. Everything else in that project was already clean: bin/, tmp/,
// log/ and storage/ produced zero nodes, so they are deliberately not listed.
//
// The list stays language-neutral: one project is often Rails and Python at
// once. Gitignore syntax; graphify merges it with .gitignore, and it can only
// ever exclude more, never re-include.
export const GRAPH_NOISE_PATTERNS = [
  '# unitbob: keep the graph about your own business code',
  '.unitbob/',

  // Third-party code committed into the repo. In Rails, `vendor/` is the
  // convention for it, and `app/assets/javascripts/` is where sprockets-era
  // apps dumped libraries — on the measured app that folder was moment.js,
  // datatables.js and jquery.inputmask, against a single node of own code. A
  // modern Rails app keeps its own JS in `app/javascript/`, which stays.
  'vendor/',
  'app/assets/javascripts/',
  'app/assets/builds/',
  'app/assets/config/',
  'public/assets/',
  'public/packs/',
  '*.min.js',
  '*.min.css',
  '*.bundle.js',

  // Generated code: schema history and codegen output. Describes the shape of
  // data, never the behaviour a guardrail could protect.
  'db/migrate/',
  'db/schema.rb',
  'db/structure.sql',
  'migrations/',
  '__generated__/',
  '*_pb2.py',
  '*_pb2_grpc.py',
  '*_pb.js',

  // Type declarations — a contract for a compiler, with no runtime behaviour.
  '*.d.ts',
  '*.pyi',
];

export function ensureUnitbobIgnored(projectRoot: string): void {
  // `.graphifyignore` is unitbob's own bookkeeping, like the other two entries —
  // the user never edits it, so it stays out of their commits.
  ensureLines(join(projectRoot, '.gitignore'), ['.unitbob/', 'graphify-out/', '.graphifyignore']);
  ensureLines(join(projectRoot, '.graphifyignore'), GRAPH_NOISE_PATTERNS);
}

// Appends whichever lines are missing, in one write, leaving the user's own
// entries (and their order) untouched. Idempotent: a second run adds nothing.
function ensureLines(path: string, lines: string[]): void {
  let current = '';
  if (existsSync(path)) current = readFileSync(path, 'utf8');

  const present = new Set(current.split('\n').map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) return;

  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${current}${prefix}${missing.join('\n')}\n`);
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
