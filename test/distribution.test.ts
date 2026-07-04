import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const connectorRoot = fileURLToPath(new URL('..', import.meta.url));
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const cliDistPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const commandsDir = fileURLToPath(new URL('../plugin/commands', import.meta.url));
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
  assert.deepEqual(packageJson.bin, { unitbob: 'dist/cli.js' });
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
  const cliFile = pack.files.find((file) => file.path === 'dist/cli.js');

  assert.ok(paths.includes('dist/cli.js'));
  assert.equal(cliFile?.mode, 0o755);
  assert.ok(paths.every((path) => !path.startsWith('src/')));
  assert.ok(paths.every((path) => !path.startsWith('test/')));

  for (const path of paths) {
    if (!path.startsWith('dist/') || !path.endsWith('.js')) continue;

    const sourcePath = `${connectorRoot}/src/${path.slice('dist/'.length, -'.js'.length)}.ts`;
    assert.ok(existsSync(sourcePath), `${path} is stale built output with no matching source file`);
  }
});

test('built CLI keeps the Node shebang', () => {
  execFileSync('npm', ['run', 'build'], { cwd: connectorRoot, stdio: 'pipe' });
  const firstLine = readFileSync(cliDistPath, 'utf8').split('\n')[0];

  assert.equal(firstLine, '#!/usr/bin/env node');
});

test('Claude Code plugin commands pin the connector package version', () => {
  const version = connectorVersion();
  // Spec 29: warnings suppressed, npm's own errors stay visible (never --silent).
  const pinnedNpx = new RegExp(`npx -y --loglevel=error unitbob@${escapeRegExp(version)}`);
  const bareNpx = /npx(?:\s+--?\S+)*\s+unitbob(?!@)/;

  for (const entry of readdirSync(commandsDir)) {
    if (!entry.endsWith('.md')) continue;

    const text = readFileSync(`${commandsDir}/${entry}`, 'utf8');
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
