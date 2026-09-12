import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  featureDir,
  featureFeaturePath,
  featureStepsPath,
  knowledgePath,
  knowledgeRequestPath,
  readKnowledge,
  readTestsOutput,
  readTestsRequest,
  testsOutputPath,
  testsRequestPath,
  writeKnowledgeRequest,
  writeTestsRequest,
  type TestsRequest,
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

// --- spec 52-3: the checks --------------------------------------------------

function testsRequest(projectRoot: string): TestsRequest {
  return {
    project_root: projectRoot,
    recipe: { name: 'feature_tests', version: 'v', text: 'Write the checks.' },
    feature: { feature_id: 12, title: 'Refunds', status: 'knowledge' },
    feature_tag: 'unitbob_feature_12',
    assignment: { capabilities: [{ capability_id: 'feature_12' }] },
    scenarios: [{ name: 'A buyer asks for a refund', steps: [{ keyword: 'Given', text: 'a paid order' }], source: 'confirmed' }],
    knowledge_path: knowledgePath(projectRoot, 12),
    knowledge_digest: 'k',
    runner: 'cucumber',
    runner_manifest: { runner: 'cucumber' },
    main_suite: 'not_built',
    feature_path: featureFeaturePath(12),
    steps_path: featureStepsPath(12, 'cucumber'),
    output_path: testsOutputPath(projectRoot, 12),
  };
}

test('the checks’ request and answer sit beside the talk’s, in the feature folder', () => {
  const projectRoot = tmpProject();
  assert.equal(testsRequestPath(projectRoot, 12), join(featureDir(projectRoot, 12), 'tests-request.json'));
  assert.equal(testsOutputPath(projectRoot, 12), join(featureDir(projectRoot, 12), 'tests-output.json'));
});

test('the checks are named after the feature, the step file as the runner collects it', () => {
  assert.equal(featureFeaturePath(12), '.unitbob/behavioral/features/feature_12.feature');
  assert.equal(featureStepsPath(12, 'cucumber'), '.unitbob/behavioral/step_definitions/feature_12_steps.rb');
  assert.equal(featureStepsPath(12, 'cucumber-js'), '.unitbob/behavioral/step_definitions/feature_12_steps.js');
  assert.equal(featureStepsPath(12, 'pytest-bdd'), '.unitbob/behavioral/step_definitions/test_feature_12_steps.py');
});

test('writes the tests request and reads it back', () => {
  const projectRoot = tmpProject();
  const request = testsRequest(projectRoot);

  writeTestsRequest(projectRoot, 12, request);

  assert.deepEqual(JSON.parse(readFileSync(testsRequestPath(projectRoot, 12), 'utf8')), request);
  assert.deepEqual(readTestsRequest(projectRoot, 12), request);
});

test('names the verb to run when the tests request is missing', () => {
  assert.throws(() => readTestsRequest(tmpProject(), 12), /tests-request\.json not found — run `npx unitbob tests-prepare 12` first/);
});

test('reads the answer with bare paths, taking the files from disk under the behavioral root', () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral', 'features'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral', 'step_definitions'), { recursive: true });
  writeFileSync(join(projectRoot, featureFeaturePath(12)), 'Feature: Refunds\n');
  writeFileSync(join(projectRoot, featureStepsPath(12, 'cucumber')), "Given('a paid order') { }\n");
  mkdirSync(featureDir(projectRoot, 12), { recursive: true });
  writeFileSync(testsOutputPath(projectRoot, 12), JSON.stringify({
    suite_file: { path: featureFeaturePath(12), support_files: [{ path: featureStepsPath(12, 'cucumber') }] },
    runner_manifest: { runner: 'cucumber', language: 'ruby' },
    test_metadata: { capabilities: [] },
  }));

  const output = readTestsOutput(projectRoot, 12);

  assert.deepEqual(output.suite_file, {
    path: featureFeaturePath(12), content: 'Feature: Refunds\n',
    support_files: [{ path: featureStepsPath(12, 'cucumber'), content: "Given('a paid order') { }\n" }],
  });
  assert.deepEqual(output.runner_manifest, { runner: 'cucumber', language: 'ruby' });
  assert.deepEqual(output.test_metadata, { capabilities: [] });
});

test('refuses an answer outside the behavioral root or without its parts', () => {
  const projectRoot = tmpProject();
  mkdirSync(featureDir(projectRoot, 12), { recursive: true });
  assert.throws(() => readTestsOutput(projectRoot, 12), /tests-output\.json not found/);

  writeFileSync(testsOutputPath(projectRoot, 12), JSON.stringify({ suite_file: { path: 'spec/x.feature' }, runner_manifest: { runner: 'cucumber' }, test_metadata: {} }));
  assert.throws(() => readTestsOutput(projectRoot, 12), /\.unitbob\/behavioral/);

  writeFileSync(testsOutputPath(projectRoot, 12), JSON.stringify({ suite_file: { path: featureFeaturePath(12) }, test_metadata: {} }));
  assert.throws(() => readTestsOutput(projectRoot, 12), /missing runner_manifest/);
});
