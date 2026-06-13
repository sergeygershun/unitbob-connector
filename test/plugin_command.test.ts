import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mapCommandPath = fileURLToPath(new URL('../../plugin/commands/map.md', import.meta.url));

test('/unitbob map command stitches connector hands and is self-contained', () => {
  const text = readFileSync(mapCommandPath, 'utf8');

  assert.match(text, /npx unitbob map-prepare/);
  assert.match(text, /npx unitbob put-map-build/);
  assert.match(text, /Read `\.unitbob\/map-build\/request\.json`/);
  assert.match(text, /Write strict JSON only/);
  assert.doesNotMatch(text, /ai\/agents\/map_builder\.md/);
  assert.doesNotMatch(text, /npx unitbob map(?!-)/);
});
