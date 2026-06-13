import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mapCommandPath = fileURLToPath(new URL('../../plugin/commands/map.md', import.meta.url));
const suiteCommandPath = fileURLToPath(new URL('../../plugin/commands/suite.md', import.meta.url));

test('/unitbob map command stitches connector hands and is self-contained', () => {
  const text = readFileSync(mapCommandPath, 'utf8');

  assert.match(text, /npx unitbob map-prepare/);
  assert.match(text, /npx unitbob put-map-build/);
  assert.match(text, /Read `\.unitbob\/map-build\/request\.json`/);
  assert.match(text, /Write strict JSON only/);
  assert.doesNotMatch(text, /ai\/agents\/map_builder\.md/);
  assert.doesNotMatch(text, /npx unitbob map(?!-)/);
});

test('/unitbob suite command stitches suite-prepare, the host agent, and put-suite-build', () => {
  const text = readFileSync(suiteCommandPath, 'utf8');

  assert.match(text, /npx unitbob suite-prepare/);
  assert.match(text, /npx unitbob put-suite-build/);
  assert.match(text, /Read `\.unitbob\/suite-build\/request\.json`/);
  assert.match(text, /ai\/agents\/suite_builder\.md/);
  assert.match(text, /Write strict JSON only/);
  // Never asks the connector to interpret the suite — it only stitches hands.
  assert.doesNotMatch(text, /npx unitbob suite(?!-)/);
});
