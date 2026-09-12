import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  featureDir,
  knowledgePath,
  knowledgeRequestPath,
  readKnowledge,
  writeKnowledgeRequest,
} from '../src/files/features.ts';
import type { KnowledgePacket, Recipe } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-features-files-'));
}

const recipe: Recipe = { name: 'feature_grill', version: 'abc', text: 'Talk the feature through.' };
const packet: KnowledgePacket = {
  feature: {
    feature_id: 12,
    title: 'Refunds',
    intent: 'I want refunds for paid orders',
    status: 'intent',
    created_at: '2026-09-12T10:00:00Z',
  },
  affected: [
    { id: 'billing', title: 'Billing', why: 'Money moves.', headline: 'The shopper can pay', status: 'passed', gone: false },
  ],
  knowledge: null,
};

// Spec 52-2 is the first spec to give a feature a folder of its own; 52-3
// puts its own request next to this one.
test('the feature folder is .unitbob/features/<id>, with request.json and knowledge.md in it', () => {
  assert.equal(featureDir('/p', 12), join('/p', '.unitbob', 'features', '12'));
  assert.equal(knowledgeRequestPath('/p', 12), join('/p', '.unitbob', 'features', '12', 'request.json'));
  assert.equal(knowledgePath('/p', 12), join('/p', '.unitbob', 'features', '12', 'knowledge.md'));
});

test('writes the request with the recipe, the packet, the local folders and where the file goes', () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral'), { recursive: true });

  const request = writeKnowledgeRequest(projectRoot, 12, recipe, packet);
  const written = JSON.parse(readFileSync(knowledgeRequestPath(projectRoot, 12), 'utf8'));

  assert.deepEqual(written, request);
  assert.equal(written.project_root, projectRoot);
  assert.deepEqual(written.recipe, recipe);
  assert.deepEqual(written.feature, packet.feature);
  assert.deepEqual(written.affected, packet.affected);
  assert.equal(written.knowledge, null);
  assert.equal(written.behavioral_suite_path, join(projectRoot, '.unitbob', 'behavioral'));
  assert.equal(written.map_documents_path, null);
  assert.equal(written.output_path, knowledgePath(projectRoot, 12));
});

test('carries an earlier knowledge text when the talk was held before', () => {
  const projectRoot = tmpProject();

  const request = writeKnowledgeRequest(projectRoot, 12, recipe, { ...packet, knowledge: '# Refunds\n' });

  assert.equal(request.knowledge, '# Refunds\n');
});

test('reads knowledge.md back as text', () => {
  const projectRoot = tmpProject();
  const path = knowledgePath(projectRoot, 12);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '# Refunds\n\n## Intent\n');

  assert.equal(readKnowledge(projectRoot, 12), '# Refunds\n\n## Intent\n');
});

test('names the path when knowledge.md is missing or empty', () => {
  const projectRoot = tmpProject();
  const path = knowledgePath(projectRoot, 12);

  assert.throws(() => readKnowledge(projectRoot, 12), new RegExp(`No knowledge file at ${path}`));

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '  \n');
  assert.throws(() => readKnowledge(projectRoot, 12), new RegExp(`${path} is empty`));
});
