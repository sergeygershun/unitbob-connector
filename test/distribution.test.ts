import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const connectorRoot = fileURLToPath(new URL('..', import.meta.url));
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const binDistPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const workflowsDir = fileURLToPath(new URL('../plugin/skills/unitbob/workflows', import.meta.url));
const pluginJsonPath = fileURLToPath(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url));
const marketplaceJsonPath = fileURLToPath(new URL('../.claude-plugin/marketplace.json', import.meta.url));

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function connectorVersion(): string {
  const packageJson = readJson(packageJsonPath);
  assert.equal(typeof packageJson.version, 'string');
  return packageJson.version;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('npm package metadata is publishable as the public unitbob CLI', () => {
  const packageJson = readJson(packageJsonPath);

  assert.equal(packageJson.name, 'unitbob');
  assert.deepEqual(packageJson.bin, { unitbob: 'dist/bin.js' });
  assert.deepEqual(packageJson.files, ['dist']);

  const scripts = packageJson.scripts as Record<string, string>;
  assert.equal(scripts.prepublishOnly, 'npm run build');

  const publishConfig = packageJson.publishConfig as Record<string, string>;
  assert.equal(publishConfig.access, 'public');
});

test('packed npm tarball includes built CLI output and excludes source and tests', () => {
  execFileSync('npm', ['run', 'build'], { cwd: connectorRoot, stdio: 'pipe' });
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: connectorRoot,
    encoding: 'utf8',
  });
  const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string; mode: number }> }>;
  const paths = pack.files.map((file) => file.path);
  const binFile = pack.files.find((file) => file.path === 'dist/bin.js');

  assert.ok(paths.includes('dist/bin.js'));
  assert.equal(binFile?.mode, 0o755);
  assert.ok(paths.every((path) => !path.startsWith('src/')));
  assert.ok(paths.every((path) => !path.startsWith('test/')));

  for (const path of paths) {
    if (!path.startsWith('dist/') || !path.endsWith('.js')) continue;

    const sourcePath = `${connectorRoot}/src/${path.slice('dist/'.length, -'.js'.length)}.ts`;
    assert.ok(existsSync(sourcePath), `${path} is stale built output with no matching source file`);
  }
});

test('the built binary keeps the Node shebang', () => {
  execFileSync('npm', ['run', 'build'], { cwd: connectorRoot, stdio: 'pipe' });
  const firstLine = readFileSync(binDistPath, 'utf8').split('\n')[0];

  assert.equal(firstLine, '#!/usr/bin/env node');
});

// npm installs a `bin` as a symlink in node_modules/.bin, so `npx unitbob` never
// executes the real file path. Node resolves the entry module to its realpath,
// which is why an entry point that compares itself to `process.argv[1]` runs
// fine from a checkout and does nothing at all once installed. Execute the built
// binary the way a client does — through a symlink — so that stays impossible.
test('the built binary still runs when invoked through an npm-style bin symlink', () => {
  execFileSync('npm', ['run', 'build'], { cwd: connectorRoot, stdio: 'pipe' });
  const link = join(mkdtempSync(join(tmpdir(), 'unitbob-bin-')), 'unitbob');
  symlinkSync(binDistPath, link);

  const output = execFileSync(link, ['--help'], { encoding: 'utf8' });

  assert.match(output, /^unitbob — thin local hands/);
});

// The npx invocations live in the skill's workflow files — the one copy both the
// commands and the skill run. The commands themselves are pointers and name no
// version, so there is nothing in them to fall out of date.
test('Claude Code plugin workflows pin the connector package version', () => {
  const version = connectorVersion();
  // Spec 29: warnings suppressed, npm's own errors stay visible (never --silent).
  const pinnedNpx = new RegExp(`npx -y --loglevel=error unitbob@${escapeRegExp(version)}`);
  const bareNpx = /npx(?:\s+--?\S+)*\s+unitbob(?!@)/;

  for (const entry of readdirSync(workflowsDir)) {
    if (!entry.endsWith('.md')) continue;

    const text = readFileSync(`${workflowsDir}/${entry}`, 'utf8');
    assert.doesNotMatch(text, bareNpx, `${entry} must not use bare npx unitbob`);
    assert.doesNotMatch(text, /--silent/, `${entry} must not swallow npm errors with --silent`);
    assert.doesNotMatch(text, /ai\/agents\//, `${entry} must be self-contained for Claude Code installs`);
    assert.match(text, pinnedNpx, `${entry} must pin ${version}`);
  }
});

test('Claude Code marketplace points at the co-located plugin', () => {
  const marketplace = readJson(marketplaceJsonPath);
  const plugin = readJson(pluginJsonPath);
  const plugins = marketplace.plugins as Array<Record<string, unknown>>;

  assert.equal(marketplace.name, 'unitbob');
  assert.deepEqual(marketplace.owner, { name: 'Unitbob' });
  assert.equal(plugin.name, 'unitbob');
  assert.equal(plugin.version, connectorVersion());
  assert.ok(
    plugins.some((entry) => entry.name === 'unitbob' && entry.source === './plugin'),
    `${basename(marketplaceJsonPath)} must reference ./plugin`,
  );
});
