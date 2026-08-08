import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function agent(name: string): { frontmatter: string; body: string } {
  const text = readFileSync(fileURLToPath(new URL(`../plugin/agents/${name}.md`, import.meta.url)), 'utf8');
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
  return { frontmatter, body: text.slice(text.indexOf('\n---\n', 3) + 5).replace(/\s+/g, ' ') };
}

test('suite-worker has a mechanical 60-turn Sonnet ceiling and one plan-item contract', () => {
  const { frontmatter, body } = agent('suite-worker');
  assert.match(frontmatter, /^name: suite-worker$/m);
  assert.match(frontmatter, /^model: sonnet$/m);
  assert.match(frontmatter, /^maxTurns: 60$/m);
  assert.match(body, /exactly one worker-plan item/i);
  assert.match(body, /checkpoint before.*source/i);
  assert.match(body, /only.*owned_paths/i);
  assert.match(body, /unitbob:fact-finder/);
  assert.match(body, /never run.*suite/i);
  assert.match(body, /one final read/i);
});

test('suite-repair-worker has a fresh 20-turn ceiling and cannot widen or recur', () => {
  const { frontmatter, body } = agent('suite-repair-worker');
  assert.match(frontmatter, /^name: suite-repair-worker$/m);
  assert.match(frontmatter, /^model: sonnet$/m);
  assert.match(frontmatter, /^maxTurns: 20$/m);
  assert.match(body, /one failure packet/i);
  assert.match(body, /unresolved_promises.*first/i);
  assert.match(body, /do not expand/i);
  assert.match(body, /never run.*suite/i);
  assert.match(body, /do not delegate.*repair/i);
});
