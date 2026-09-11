// Spawn helper for the local tools the connector drives (graphify, rspec). It
// captures stdout/stderr/exit code and hands them back untouched — shaping or
// interpreting that output is the caller's (and ultimately Rails') job.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ProcResult {
  stdout: string;
  stderr: string;
  code: number | null;
  // Set only when the *place* failed to carry the command out — the container
  // stopped between the check and the spawn, the image has no such executable
  // (spec 36, criterion 8). It is never a result about the project's code, and
  // nothing downstream may read it as one.
  placeFailure?: string;
}

// Can this path actually be spawned? A binstub that exists but has lost its
// executable bit is a real state — checkouts over a filesystem with no
// permission bits, an archive unpacked without them — and `spawn` answers it
// with an EACCES `error` event, which arrives as a thrown exception rather than
// an exit code. Callers that pick "the project's own binstub, else the global
// tool" have to ask this before choosing, or the fallback never gets its turn.
export function executable(path: string): boolean {
  try {
    return existsSync(path) && (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export const GRAPHIFY_TIMEOUT_MS = 10 * 60 * 1000;

// The raw spawn, and it stays raw: this is how the connector starts the tools it
// brought with it. `graphify` is installed on the vibecoder's own machine and
// only ever reads files, so it has no business travelling anywhere.
//
// A command that needs the *project's* dependencies goes through
// `runInProject` (`runner/place.ts`) instead — those may have to start where the
// project's toolchain lives, which is not always this machine (spec 36). The
// boundary is deliberately visible at each call site rather than hidden in a
// mode: which function is called is the whole rule.
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

// The oldest graphify the map may be built with. Below it, `detect.py` drops
// any file whose name ends in `token`, `secret`, `password` or `credential` as
// a probable secret store — by the name alone, before the file is parsed, and
// without a word on stdout: `graphify update` never prints the list it keeps.
// On the bench, 2026-09-11, that took `app/api/tokens.py` out of microblog and
// `src/controllers/auth/token.js` out of soul, so both maps were built without
// the sign-in code and nothing said so. `.graphifyignore` cannot re-include a
// file graphify has decided is sensitive, so the only cure is the release that
// exempts real source files (`.py`, `.js`, `.ts`, `.rb`) from that rule, and
// 0.9.18 is the first one that does — checked release by release.
export const GRAPHIFY_MIN_VERSION = '0.9.18';

const GRAPHIFY_INSTALL =
  '`pip install graphifyy && graphify install` (PyPI package "graphifyy", command "graphify", needs Python 3.10+)';

export async function requireGraphify(run: typeof runProcess = runProcess): Promise<void> {
  let result: ProcResult;
  try {
    result = await run('graphify', ['--version']);
  } catch (err) {
    throw new Error(
      `graphify is required but was not found or did not run. Install it with ${GRAPHIFY_INSTALL}, ` +
        `then retry (${(err as Error).message}).`,
    );
  }

  // `graphify 0.9.58` on stdout. A release too old to answer `--version` at all
  // (0.7.x says "unknown command") is older than the floor by definition, so it
  // is refused with the same sentence rather than a different one.
  const version = /\bgraphify\s+(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1];
  if (version && !olderThan(version, GRAPHIFY_MIN_VERSION)) return;

  const found = version ?? (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`);
  throw new Error(
    `graphify ${found} is installed, and Unitbob needs ${GRAPHIFY_MIN_VERSION} or newer. Older releases ` +
      `silently leave out any source file whose name ends in "token", "secret" or "password" — ` +
      `the sign-in code, typically — so the map would be built without it and nobody would be told. ` +
      `Upgrade with \`pip install --upgrade graphifyy\`, then retry.`,
  );
}

function olderThan(version: string, floor: string): boolean {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
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
  //
  // Anchored to the repository root, and this is the whole difference between a
  // pattern and a blind spot: a gitignore pattern whose only separator is the
  // trailing one is *not* relative to the root, so a bare `vendor/` matched a
  // `vendor` directory at any depth. On one real Rails app (2026-08-16) that
  // took `app/controllers/vendor/` with it — the project's own contractor
  // console, gone from the map for a whole run, with nothing said about it.
  '/vendor/',
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

  // Spec 34-6, criterion 6. Unitbob's own session reports, left in the repo root
  // by the operator, are read as source: on a2time, 2026-08-10, two of them
  // contributed 44 and 25 nodes and pushed their community to third-largest in
  // the whole project. The more often you run unitbob, the dirtier its map gets —
  // a feedback loop with no floor.
  '/unitbob*.md',

  // Test scaffolding and boot wiring. Factories and model specs describe the
  // fixtures a suite builds, not a business promise a guardrail could protect;
  // `config/initializers/` and `config/deploy/` run once at boot and at deploy.
  // The project's own request and feature specs stay — they are evidence of what
  // the app promises.
  'spec/factories/',
  'spec/models/',
  'config/deploy/',
  'config/initializers/',
];

export function ensureUnitbobIgnored(projectRoot: string): void {
  // `.graphifyignore` is unitbob's own bookkeeping, like the other two entries —
  // the user never edits it, so it stays out of their commits.
  ensureLines(join(projectRoot, '.gitignore'), ['.unitbob/', 'graphify-out/', '.graphifyignore']);

  // Before `ensureLines`, never after. `ensureLines` appends whatever the
  // template is missing, so on an already-installed project the anchored form
  // would land in the file *next to* the old unanchored one, and the old one
  // would go on eating `app/**/vendor/` exactly as before.
  replaceLine(join(projectRoot, '.graphifyignore'), 'vendor/', '/vendor/');
  ensureLines(join(projectRoot, '.graphifyignore'), GRAPH_NOISE_PATTERNS);
}

// Rewrite one line this connector wrote in an earlier release, and nothing else.
// The comparison is exact on the trimmed line, so a line the user wrote —
// `vendor/bundle/`, `# vendor`, anything else — is left byte for byte as they
// wrote it. Idempotent: a second run finds nothing to replace.
function replaceLine(path: string, from: string, to: string): void {
  if (!existsSync(path)) return;

  const lines = readFileSync(path, 'utf8').split('\n');
  if (!lines.some((line) => line.trim() === from)) return;

  writeFileSync(path, lines.map((line) => (line.trim() === from ? to : line)).join('\n'));
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

export interface IgnoreExclusion {
  pattern: string;
  files: number;
}

// What the ignore file actually costs, counted in files, pattern by pattern.
//
// This is the general cure and the reason it is worth more than the particular
// one above: an ignore pattern is a silent instrument. Everything it matches
// simply never reaches the graph, and the subsystem it swallowed leaves no trace
// of having existed — which is how one over-broad line hid a whole console and
// the run looked complete. Anchoring `/vendor/` fixes the blind spot we found;
// this makes the next one visible, whichever pattern causes it.
//
// The whole file is read, not just this connector's own template: a line the
// user wrote can hide a subsystem exactly as well as a line we wrote.
export function ignoreExclusions(projectRoot: string): IgnoreExclusion[] {
  const path = join(projectRoot, '.graphifyignore');
  if (!existsSync(path)) return [];

  const counted = readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const matcher = compileIgnorePattern(line);
      return matcher ? [{ pattern: line.trim(), matcher, files: 0 }] : [];
    });
  if (counted.length === 0) return [];

  for (const file of filesUnder(projectRoot)) {
    // Every pattern that matches is credited, not just the first: two patterns
    // covering the same directory are each costing you those files, and picking
    // a winner would report one of them as harmless.
    for (const entry of counted) {
      if (matchesIgnorePattern(file, entry.matcher)) entry.files += 1;
    }
  }

  return counted.filter((entry) => entry.files > 0).map(({ pattern, files }) => ({ pattern, files }));
}

interface IgnoreMatcher {
  dirOnly: boolean;
  regex: RegExp;
}

// The working subset of gitignore syntax — the part the patterns in this file
// actually use. The rule that matters is the anchoring one: a pattern with a
// separator anywhere but the end is relative to the repository root, and one
// without is not. That single rule is the entire distance between `/vendor/`
// and `vendor/`, so it is spelled out here rather than assumed.
//
// Negations (`!`) are not supported and are skipped rather than half-honoured:
// counting a re-include as an exclusion would report a loss that never happened.
function compileIgnorePattern(line: string): IgnoreMatcher | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) return null;

  const dirOnly = trimmed.endsWith('/');
  const path = dirOnly ? trimmed.slice(0, -1) : trimmed;
  const anchored = path.includes('/');
  const source = path.replace(/^\//, '').split('/').map(globSegment).join('/');

  return { dirOnly, regex: new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`) };
}

function globSegment(segment: string): string {
  return segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
}

function matchesIgnorePattern(relativePath: string, matcher: IgnoreMatcher): boolean {
  const parts = relativePath.split('/');
  // A pattern ending in `/` matches directories only, so for a file it is the
  // ancestors that have to match and never the file itself. Excluding a
  // directory excludes everything under it, which is why every prefix is tried.
  const deepest = matcher.dirOnly ? parts.length - 1 : parts.length;

  for (let depth = 1; depth <= deepest; depth += 1) {
    if (matcher.regex.test(parts.slice(0, depth).join('/'))) return true;
  }
  return false;
}

// Directories graphify drops on its own (see the note above
// `GRAPH_NOISE_PATTERNS`), plus `.git`. Counting inside them would charge our
// patterns for files that were never going to reach the graph anyway, and the
// number the reader is weighing is "what did this line cost me".
const ALREADY_OFF_THE_GRAPH: ReadonlySet<string> = new Set([
  '.git', 'node_modules', 'venv', '.venv', 'dist', 'build', 'target', 'out', '__pycache__',
]);

// Symlinks are neither followed nor counted: a link is not a file the graph
// would have gained, and following one can walk forever.
function filesUnder(root: string, relative = ''): string[] {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return ALREADY_OFF_THE_GRAPH.has(entry.name) ? [] : filesUnder(root, path);
    return entry.isFile() ? [path] : [];
  });
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
