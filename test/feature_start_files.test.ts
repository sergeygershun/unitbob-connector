import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  outputPath,
  readFeatureAnswer,
  requestPath,
  writeFeatureStartRequest,
  type Capability,
} from '../src/files/featureStart.ts';
import type { Recipe } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-feature-files-'));
}

const recipe: Recipe = { name: 'feature_intent', version: 'abc', text: 'Name what this change may touch.' };
const capabilities: Capability[] = [
  {
    capability_id: 'posts',
    title: 'Posts',
    description: 'People write and read posts.',
    surfaces: ['GET /posts'],
    tables: ['posts'],
    externals: [],
  },
];

test('writes the request with the recipe, the capabilities and where the answer goes', () => {
  const projectRoot = tmpProject();

  const request = writeFeatureStartRequest(projectRoot, recipe, capabilities);
  const written = JSON.parse(readFileSync(requestPath(projectRoot), 'utf8'));

  assert.equal(written.project_root, projectRoot);
  assert.deepEqual(written.recipe, recipe);
  assert.deepEqual(written.capabilities, capabilities);
  assert.equal(written.output_path, outputPath(projectRoot));
  assert.equal(request.output_path, join(projectRoot, '.unitbob', 'feature-start', 'feature.json'));
});

// The local suites and map documents are optional reading, and they are not
// always there: the behavioral suite exists only after a run, the map documents
// only after a map build on this machine. Absent, the path is null — never a
// path to nothing.
test('names the local suite and map documents only when they are on disk', () => {
  const projectRoot = tmpProject();

  const bare = writeFeatureStartRequest(projectRoot, recipe, capabilities);
  assert.equal(bare.behavioral_suite_path, null);
  assert.equal(bare.map_documents_path, null);

  mkdirSync(join(projectRoot, '.unitbob', 'behavioral'), { recursive: true });
  const surface = join(projectRoot, '.unitbob', 'map-build', 'surface_document.json');
  mkdirSync(dirname(surface), { recursive: true });
  writeFileSync(surface, '{}');

  const present = writeFeatureStartRequest(projectRoot, recipe, capabilities);
  assert.equal(present.behavioral_suite_path, join(projectRoot, '.unitbob', 'behavioral'));
  assert.equal(present.map_documents_path, join(projectRoot, '.unitbob', 'map-build'));
});

test('reads the answer in the wire shape', () => {
  const projectRoot = tmpProject();
  mkdirSync(dirname(outputPath(projectRoot)), { recursive: true });
  writeFileSync(
    outputPath(projectRoot),
    JSON.stringify({
      title: 'Comments on posts',
      intent: 'I want to add comments to posts',
      affected: [{ id: 'posts', why: 'A comment lives on the post page.' }],
      extra: 'ignored',
    }),
  );

  assert.deepEqual(readFeatureAnswer(projectRoot), {
    title: 'Comments on posts',
    intent: 'I want to add comments to posts',
    affected: [{ id: 'posts', why: 'A comment lives on the post page.' }],
  });
});

test('an empty affected list is a legitimate answer', () => {
  const projectRoot = tmpProject();
  mkdirSync(dirname(outputPath(projectRoot)), { recursive: true });
  writeFileSync(outputPath(projectRoot), JSON.stringify({ title: 'PDF export', intent: 'export as PDF', affected: [] }));

  assert.deepEqual(readFeatureAnswer(projectRoot).affected, []);
});

// The error names the field, so the host fixes the file rather than guessing.
test('names the missing field of a malformed answer', () => {
  const projectRoot = tmpProject();
  mkdirSync(dirname(outputPath(projectRoot)), { recursive: true });

  writeFileSync(outputPath(projectRoot), JSON.stringify({ title: '', intent: 'x', affected: [] }));
  assert.throws(() => readFeatureAnswer(projectRoot), /"title"/);

  writeFileSync(outputPath(projectRoot), JSON.stringify({ title: 'x', affected: [] }));
  assert.throws(() => readFeatureAnswer(projectRoot), /"intent"/);

  writeFileSync(outputPath(projectRoot), JSON.stringify({ title: 'x', intent: 'y', affected: 'posts' }));
  assert.throws(() => readFeatureAnswer(projectRoot), /"affected"/);

  writeFileSync(outputPath(projectRoot), JSON.stringify({ title: 'x', intent: 'y', affected: [{ why: 'no id' }] }));
  assert.throws(() => readFeatureAnswer(projectRoot), /affected\[0\]\.id/);
});

test('says where the answer was expected when there is none', () => {
  const projectRoot = tmpProject();
  assert.throws(() => readFeatureAnswer(projectRoot), /feature\.json/);
});
