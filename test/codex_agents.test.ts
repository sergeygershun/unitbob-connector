import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCodexAgents } from '../src/verbs/codexInstall.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function codexAgent(name: string): string {
  return readFileSync(`${root}/plugin/codex/agents/${name}.toml`, 'utf8');
}

function codexInstructions(agent: string): string {
  return agent.match(/developer_instructions = '''\n([\s\S]*?)\n'''/)?.[1].trim() ?? '';
}

test('Codex suite agents use the accepted cheaper models and fixed rollout budgets', () => {
  const worker = codexAgent('suite-worker');
  const repair = codexAgent('suite-repair-worker');

  for (const agent of [worker, repair]) {
    assert.match(agent, /^model = "gpt-5\.6-terra"$/m);
    assert.match(agent, /^model_reasoning_effort = "medium"$/m);
    assert.match(agent, /^\[features\.rollout_budget\]$/m);
    assert.match(agent, /^enabled = true$/m);
  }
  assert.match(worker, /^limit_tokens = 40000$/m);
  assert.match(repair, /^limit_tokens = 40000$/m);
});

test('only the three risky Codex roles are installed and budgeted', () => {
  const names = readdirSync(`${root}/plugin/codex/agents`).sort();

  assert.deepEqual(names, ['fact-finder.toml', 'suite-repair-worker.toml', 'suite-worker.toml']);
  for (const name of names) {
    assert.match(codexAgent(name.replace(/\.toml$/, '')), /^\[features\.rollout_budget\]$/m);
  }
});

test('Codex fact finder is cheap, read-only, and bounded', () => {
  const finder = codexAgent('fact-finder');

  assert.match(finder, /^model = "gpt-5\.6-luna"$/m);
  assert.match(finder, /^model_reasoning_effort = "low"$/m);
  assert.match(finder, /^sandbox_mode = "read-only"$/m);
  assert.match(finder, /^\[features\.rollout_budget\]$/m);
  assert.match(finder, /^limit_tokens = 20000$/m);
});

test('Codex and Claude definitions carry the same behavioral instructions with host role names', () => {
  for (const name of ['suite-worker', 'suite-repair-worker', 'fact-finder']) {
    const claude = readFileSync(`${root}/plugin/agents/${name}.md`, 'utf8');
    const body = claude.slice(claude.indexOf('\n---\n', 3) + 5).trim();
    const codex = codexAgent(name);
    const normalizedCodexInstructions = codexInstructions(codex).replace(
      '`fact-finder`',
      '`unitbob:fact-finder`',
    );

    assert.equal(normalizedCodexInstructions, body);
  }
});

test('a budget continuation preserves the existing checkpoint instead of reinitializing it', () => {
  const worker = codexInstructions(codexAgent('suite-worker'));

  assert.match(worker, /approved fresh incarnation after a\s+native budget stop/i);
  assert.match(worker, /preserve the supplied checkpoint and completed files/i);
  assert.match(worker, /never initialize that checkpoint again/i);
});

test('codex-install places all definitions in the Codex user agent directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'unitbob-codex-home-'));
  const output: string[] = [];

  installCodexAgents([], { home, stdout: { write: (chunk) => output.push(chunk) } });

  for (const name of ['suite-worker', 'suite-repair-worker', 'fact-finder']) {
    const installed = join(home, '.codex', 'agents', `${name}.toml`);
    assert.ok(existsSync(installed), `${name} was not installed`);
    assert.equal(readFileSync(installed, 'utf8'), codexAgent(name));
  }
  assert.match(output.join(''), /Installed 3 Unitbob Codex agent definitions/);
});

test('codex-install is idempotent and never overwrites a user-owned definition', () => {
  const home = mkdtempSync(join(tmpdir(), 'unitbob-codex-home-'));
  const targetDir = join(home, '.codex', 'agents');

  installCodexAgents([], { home, stdout: { write: () => undefined } });
  assert.doesNotThrow(() =>
    installCodexAgents([], { home, stdout: { write: () => undefined } }),
  );

  writeFileSync(join(targetDir, 'suite-worker.toml'), 'user owned\n');
  assert.throws(
    () => installCodexAgents([], { home, stdout: { write: () => undefined } }),
    /Refusing to overwrite.*suite-worker\.toml/,
  );
  assert.equal(readFileSync(join(targetDir, 'suite-worker.toml'), 'utf8'), 'user owned\n');
});
