import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mapCommandPath = fileURLToPath(new URL('../../plugin/commands/map.md', import.meta.url));
const suiteCommandPath = fileURLToPath(new URL('../../plugin/commands/suite.md', import.meta.url));
const fixCommandPath = fileURLToPath(new URL('../../plugin/commands/fix.md', import.meta.url));
const reshapeCommandPath = fileURLToPath(new URL('../../plugin/commands/reshape.md', import.meta.url));

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

test('/unitbob fix command stitches fix-prepare and the host fixer, with no put step', () => {
  const text = readFileSync(fixCommandPath, 'utf8');

  assert.match(text, /npx unitbob fix-prepare \$ARGUMENTS/);
  assert.match(text, /Read `\.unitbob\/fix\/request\.json`/);
  assert.match(text, /ai\/agents\/fixer\.md/);
  // Fix has no upload step — the next check shows the result.
  assert.doesNotMatch(text, /put-/);
});

test('/unitbob reshape command stitches reshape-prepare, the host reshaper, and put-reshape', () => {
  const text = readFileSync(reshapeCommandPath, 'utf8');

  assert.match(text, /npx unitbob reshape-prepare \$ARGUMENTS/);
  assert.match(text, /npx unitbob put-reshape/);
  assert.match(text, /Read `\.unitbob\/reshape\/request\.json`/);
  assert.match(text, /ai\/agents\/reshaper\.md/);
  assert.match(text, /Write strict JSON only/);
});
