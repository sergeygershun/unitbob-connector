import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mapCommandPath = fileURLToPath(new URL('../plugin/commands/map.md', import.meta.url));
const suiteCommandPath = fileURLToPath(new URL('../plugin/commands/suite.md', import.meta.url));
const fixCommandPath = fileURLToPath(new URL('../plugin/commands/fix.md', import.meta.url));
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const connectorVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version as string;
const unitbob = `npx unitbob@${connectorVersion}`;
const unitbobPattern = unitbob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('/unitbob map command stitches connector hands and is self-contained', () => {
  const text = readFileSync(mapCommandPath, 'utf8');

  assert.match(text, new RegExp(`${unitbobPattern} map-prepare`));
  assert.match(text, new RegExp(`${unitbobPattern} put-map-build`));
  assert.match(text, /Read `\.unitbob\/map-build\/request\.json`/);
  assert.match(text, /Write strict JSON only/);
  assert.doesNotMatch(text, /ai\/agents\/map_builder\.md/);
  assert.doesNotMatch(text, /npx unitbob(?!@).* map(?!-)/);
});

test('/unitbob suite command stitches suite-prepare, the host agent, and put-suite-build', () => {
  const text = readFileSync(suiteCommandPath, 'utf8');

  assert.match(text, new RegExp(`${unitbobPattern} suite-prepare`));
  assert.match(text, new RegExp(`${unitbobPattern} put-suite-build`));
  assert.match(text, /Read `\.unitbob\/suite-build\/request\.json`/);
  assert.doesNotMatch(text, /ai\/agents\/suite_builder\.md/);
  assert.match(text, /Write strict JSON only/);
  // Never asks the connector to interpret the suite — it only stitches hands.
  assert.doesNotMatch(text, /npx unitbob(?!@).* suite(?!-)/);
});

test('/unitbob fix command stitches fix-prepare and covers both fix and accept', () => {
  const text = readFileSync(fixCommandPath, 'utf8');

  assert.match(text, new RegExp(`${unitbobPattern} fix-prepare \\$ARGUMENTS`));
  assert.match(text, /Read `\.unitbob\/fix\/request\.json`/);
  assert.doesNotMatch(text, /ai\/agents\/fixer\.md/);
  // Fix edits code (no upload); accept republishes the whole suite via put-suite-build.
  assert.match(text, new RegExp(`${unitbobPattern} put-suite-build`));
});
