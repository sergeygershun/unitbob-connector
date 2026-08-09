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
  assert.match(body, /preserve the supplied checkpoint and completed files/i);
  assert.match(body, /never initialize that checkpoint again/i);
  assert.match(body, /only.*owned_paths/i);
  assert.match(body, /unitbob:fact-finder/);
  assert.match(body, /never run.*suite/i);
  assert.match(body, /one final read/i);
  assert.match(body, /final read.*confirm every `facts` entry.*object/i);
});

test('suite-repair-worker validates its owned slice within a 60-turn ceiling', () => {
  const { frontmatter, body } = agent('suite-repair-worker');
  assert.match(frontmatter, /^name: suite-repair-worker$/m);
  assert.match(frontmatter, /^model: sonnet$/m);
  assert.match(frontmatter, /^maxTurns: 60$/m);
  assert.match(body, /one failure packet/i);
  assert.match(body, /unresolved_promises.*first/i);
  assert.match(body, /do not expand/i);
  assert.match(body, /unitbob run-local <branch>/i);
  assert.match(body, /repeat.*edit.*run-local.*inspect/i);
  assert.match(body, /owned paths.*case markers/i);
  assert.match(body, /do not require.*green.*branch/i);
  assert.match(body, /runner setup.*helpers.*factories/i);
  assert.match(body, /do not run.*project.*suite/i);
  assert.match(body, /production code.*shared.*another slice/i);
  assert.match(body, /skip.*pending.*todo/i);
  assert.match(body, /ambigu.*build_error/i);
  assert.match(body, /business contract.*production source/i);
  assert.match(body, /final read.*confirm every `facts` entry.*object/i);
});
