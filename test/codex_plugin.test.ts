import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../plugin/.codex-plugin/plugin.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, unknown>;
const skill = readFileSync(
  fileURLToPath(new URL('../plugin/skills/unitbob/SKILL.md', import.meta.url)),
  'utf8',
);
const suite = readFileSync(
  fileURLToPath(new URL('../plugin/skills/unitbob/workflows/suite.md', import.meta.url)),
  'utf8',
);
const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

test('the co-located Unitbob bundle is a Codex plugin using the shared skill', () => {
  assert.equal(manifest.name, 'unitbob');
  assert.equal(manifest.version, '0.4.0');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.description, 'Unitbob business maps and executable guardrails for Codex.');
});

test('the shared skill and suite workflow do not select a Claude-only host path', () => {
  assert.doesNotMatch(skill, /\(Claude Code\) do the map-building/);
  assert.doesNotMatch(suite, /frontmatter pins Sonnet/);
  assert.doesNotMatch(suite, /survive `maxTurns`/);
  assert.match(suite, /same named role on both Claude Code and Codex/i);
});

test('Codex asks before every run whose native per-agent ceiling is unavailable or exhausted', () => {
  assert.match(suite, /rollout budget is not enforced per named agent/i);
  assert.match(suite, /ask whether to run\s+this invocation without a mechanical ceiling/i);
  assert.match(suite, /budgetLimited|session_budget_exceeded/);
  assert.match(suite, /ask the user before.*another bounded\s+incarnation/is);
  assert.match(suite, /approval applies only to that one incarnation/i);
});

test('Codex setup installs the shared plugin and the three discoverable roles', () => {
  assert.match(readme, /codex plugin marketplace add sergeygershun\/unitbob-connector/);
  assert.match(readme, /codex plugin add unitbob@unitbob/);
  assert.match(readme, /npx -y unitbob@0\.4\.0 codex-install/);
  assert.match(readme, /start a new .*Codex thread/i);
});
