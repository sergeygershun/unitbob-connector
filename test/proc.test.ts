import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  GRAPH_NOISE_PATTERNS,
  ensureUnitbobIgnored,
  ignoreExclusions,
  runGraphifyExtractKeyless,
  runProcess,
} from '../src/proc.ts';

function tmpProject(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeProjectFile(projectRoot: string, relativePath: string, content: string): void {
  const path = join(projectRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test('runGraphifyExtractKeyless runs `graphify update <root> --force` with no key and no --out', async () => {
  const projectRoot = tmpProject('unitbob-proc-project-');
  const binDir = tmpProject('unitbob-proc-bin-');
  const logPath = join(projectRoot, 'args.log');
  const graphifyPath = join(binDir, 'graphify');
  writeFileSync(
    graphifyPath,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${logPath}"\nexit 0\n`,
  );
  chmodSync(graphifyPath, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath ?? ''}`;
  try {
    const result = await runGraphifyExtractKeyless(projectRoot);
    assert.equal(result.code, 0);
  } finally {
    process.env.PATH = oldPath;
  }

  assert.deepEqual(readFileSync(logPath, 'utf8').trim().split('\n'), [
    'update',
    projectRoot,
    '--force',
  ]);
});

test('ensureUnitbobIgnored writes each pattern once and hides its own bookkeeping', () => {
  const projectRoot = tmpProject('unitbob-proc-ignore-');
  const ignorePath = join(projectRoot, '.graphifyignore');
  const gitignorePath = join(projectRoot, '.gitignore');
  writeFileSync(ignorePath, 'my-own-rule/\n');
  writeFileSync(gitignorePath, '.env\n');

  ensureUnitbobIgnored(projectRoot);
  ensureUnitbobIgnored(projectRoot);

  const patterns = readFileSync(ignorePath, 'utf8').split('\n').filter(Boolean);
  assert.equal(patterns[0], 'my-own-rule/');
  assert.equal(new Set(patterns).size, patterns.length, 'a second run must not duplicate anything');
  assert.equal(
    readFileSync(gitignorePath, 'utf8'),
    '.env\n.unitbob/\ngraphify-out/\n.graphifyignore\n',
  );
});

// Over-broad patterns fail silently — a subsystem just never reaches the map.
// These are the ones considered and rejected, pinned so they cannot drift back
// in without someone re-arguing the case.
test('ensureUnitbobIgnored leaves paths that can hold business logic alone', () => {
  const projectRoot = tmpProject('unitbob-proc-ignore-keeps-');

  ensureUnitbobIgnored(projectRoot);

  const patterns = readFileSync(join(projectRoot, '.graphifyignore'), 'utf8').split('\n');
  const keep = [
    'app/assets/', // whole folder: own JS lives here in sprockets-era Rails
    'app/javascript/', // Stimulus controllers — the recipe names them explicitly
    'bin/', // a JS project's CLI entry points are real code
    'generated/', // an ordinary folder name, not a codegen convention
    'third_party/', // a Bazel/C++/Go convention, not one of our stacks
    'lib/', // Rails and Python both put business code here
    'config/', // routes and initializers carry real wiring
    'spec/',
    'test/',
  ];
  for (const path of keep) {
    assert.ok(!patterns.includes(path), `${path} can hold business logic — must not be excluded`);
  }
});

test('ensureUnitbobIgnored keeps a pattern the project already declared', () => {
  const projectRoot = tmpProject('unitbob-proc-ignore-kept-');
  const ignorePath = join(projectRoot, '.graphifyignore');
  writeFileSync(ignorePath, 'db/migrate/\nmy-own-rule/\n');

  ensureUnitbobIgnored(projectRoot);

  const lines = readFileSync(ignorePath, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.slice(0, 2), ['db/migrate/', 'my-own-rule/']);
  assert.equal(lines.filter((line) => line === 'db/migrate/').length, 1);
});

// Spec 35-1, criterion 1. As a glob, `vendor/` is not relative to the repository
// root — it matches a `vendor` directory at any depth, so it also swallowed
// `app/controllers/vendor/` and took a whole contractor console off the map of
// one real application with nothing said about it.
test('the template anchors vendor at the repository root', () => {
  assert.ok(GRAPH_NOISE_PATTERNS.includes('/vendor/'));
  assert.ok(!GRAPH_NOISE_PATTERNS.includes('vendor/'));
});

// Editing the file alone cannot fix an installed project: `ensureLines` appends
// whatever the template is missing, so the anchored form would land next to the
// old one and the old one would keep eating `app/**/vendor/`.
test('ensureUnitbobIgnored migrates an unanchored vendor line and leaves the rest alone', () => {
  const projectRoot = tmpProject('unitbob-proc-ignore-migrate-');
  const ignorePath = join(projectRoot, '.graphifyignore');
  writeFileSync(ignorePath, '# mine\nvendor/bundle/\nvendor/\nmy-own-rule/\n');

  ensureUnitbobIgnored(projectRoot);
  const afterOnce = readFileSync(ignorePath, 'utf8');
  ensureUnitbobIgnored(projectRoot);

  assert.equal(readFileSync(ignorePath, 'utf8'), afterOnce, 'the migration must be idempotent');
  const lines = afterOnce.split('\n');
  assert.deepEqual(lines.slice(0, 4), ['# mine', 'vendor/bundle/', '/vendor/', 'my-own-rule/']);
  assert.equal(lines.filter((line) => line === 'vendor/').length, 0);
  assert.equal(lines.filter((line) => line === '/vendor/').length, 1);
});

// The general cure. Anchoring `/vendor/` fixes the blind spot we found; this is
// what makes the next one visible, whichever pattern causes it.
test('ignoreExclusions counts the files each pattern takes off the map, and stays quiet about the rest', () => {
  const projectRoot = tmpProject('unitbob-proc-exclusions-');
  writeProjectFile(projectRoot, '.graphifyignore', '# a comment\n\n/vendor/\ndb/migrate/\n*.min.js\nnothing-here/\n');
  writeProjectFile(projectRoot, 'vendor/gems/a.rb', '');
  writeProjectFile(projectRoot, 'vendor/gems/b.rb', '');
  writeProjectFile(projectRoot, 'app/controllers/vendor/console.rb', '');
  writeProjectFile(projectRoot, 'db/migrate/001_create.rb', '');
  writeProjectFile(projectRoot, 'app/assets/jquery.min.js', '');
  writeProjectFile(projectRoot, 'app/models/bill.rb', '');

  const exclusions = ignoreExclusions(projectRoot);

  assert.deepEqual(exclusions, [
    { pattern: '/vendor/', files: 2 },
    { pattern: 'db/migrate/', files: 1 },
    { pattern: '*.min.js', files: 1 },
  ]);
});

test('ensureUnitbobIgnored adds graphify-out exactly once and preserves an existing entry', () => {
  const projectRoot = tmpProject('unitbob-proc-ignore-existing-');
  const gitignorePath = join(projectRoot, '.gitignore');
  writeFileSync(gitignorePath, 'node_modules/\ngraphify-out/\n');

  ensureUnitbobIgnored(projectRoot);

  assert.equal(
    readFileSync(gitignorePath, 'utf8'),
    'node_modules/\ngraphify-out/\n.unitbob/\n.graphifyignore\n',
  );
});

// The only test that can catch a pattern that is subtly wrong — bad gitignore
// syntax, a path anchored at the wrong depth — because it runs the real graphify
// over a real tree and looks at what came out. Skipped where graphify is not
// installed; it is a prerequisite for `map`, not for the test suite.
test('the ignore rules keep business code in the graph and drop the rest', async (t) => {
  if ((await runProcess('graphify', ['--help'])).code !== 0) {
    t.skip('graphify is not installed');
    return;
  }

  const projectRoot = tmpProject('unitbob-proc-graph-');
  // Kept: business code in each supported stack.
  writeProjectFile(projectRoot, 'app/models/bill.rb', 'class Bill\n  def debt\n    42\n  end\nend\n');
  writeProjectFile(projectRoot, 'app/javascript/controllers/bill_controller.js', 'export function connect() { return 1; }\n');
  writeProjectFile(projectRoot, 'lib/pricing.py', 'def total(items):\n    return sum(items)\n');
  // Kept, and the reason the vendor pattern is anchored: this is the project's
  // own code, in a folder that happens to be named after the people it serves.
  writeProjectFile(projectRoot, 'app/controllers/vendor/console_controller.rb', 'class ConsoleController\n  def payouts\n    7\n  end\nend\n');
  // Dropped: vendored, generated, and type-only files.
  writeProjectFile(projectRoot, 'vendor/assets/moment.js', 'function moment() { return 1; }\n');
  writeProjectFile(projectRoot, 'app/assets/javascripts/datatables.js', 'function dataTable() { return 1; }\n');
  writeProjectFile(projectRoot, 'db/migrate/20200101_create_bills.rb', 'class CreateBills\n  def up\n  end\nend\n');
  writeProjectFile(projectRoot, 'app/models/migrations/0001_initial.py', 'def apply():\n    pass\n');
  writeProjectFile(projectRoot, 'types/bill.d.ts', 'export declare function debt(): number;\n');

  ensureUnitbobIgnored(projectRoot);
  const run = await runGraphifyExtractKeyless(projectRoot);
  assert.equal(run.code, 0, run.stderr);

  const graph = JSON.parse(readFileSync(join(projectRoot, 'graphify-out', 'graph.json'), 'utf8'));
  const files = new Set<string>(graph.nodes.map((node: { source_file?: string }) => node.source_file ?? ''));
  const covered = (prefix: string) => [...files].some((file) => file.startsWith(prefix));

  for (const kept of [
    'app/models/bill.rb',
    'app/javascript/controllers/bill_controller.js',
    'lib/pricing.py',
    'app/controllers/vendor/console_controller.rb',
  ]) {
    assert.ok(covered(kept), `${kept} is business code and must be in the graph`);
  }
  for (const dropped of ['vendor/', 'app/assets/', 'db/migrate/', 'app/models/migrations/', 'types/']) {
    assert.ok(!covered(dropped), `${dropped} carries no business logic and must be filtered out`);
  }
});

test('runProcess reports a timeout as a local process failure', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 1000)'],
    { timeoutMs: 20 },
  );

  assert.equal(result.code, null);
  assert.match(result.stderr, /timed out after 20ms/);
});
