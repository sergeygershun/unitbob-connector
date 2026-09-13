// `tests-review-prepare <feature_id>` (spec 52-4, AC 1.11): the request the
// independent reviewer reads for a feature's checks, in the shape of the main
// suite's `review-request.json`, plus where the promises are written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testsReviewPrepare } from '../src/verbs/testsReviewPrepare.ts';
import {
  featureFeaturePath,
  featureStepsPath,
  knowledgePath,
  testsOutputPath,
  testsRequestPath,
  testsReviewOutputPath,
  testsReviewRequestPath,
  type TestsRequest,
} from '../src/files/features.ts';
import { suiteCandidateDigest } from '../src/files/suiteBuild.ts';
import { WireError, type TestsPacket } from '../src/wire.ts';
import type { Config } from '../src/config.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-tests-review-prepare-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, token: 'secret', projectRoot };
}

const MANIFEST = { language: 'ruby', framework: 'cucumber', result_format: 'cucumber_messages', runner: 'cucumber', package_manager: 'bundler', runner_version: '9.2.0' };
const SCENARIOS: TestsPacket['scenarios'] = [
  { name: 'A buyer asks for a refund', steps: [{ keyword: 'Given', text: 'a paid order' }], source: 'confirmed' },
];

function packet(): TestsPacket {
  return {
    suite_kind: 'behavioral', source_digest: 'k', path_root: '.unitbob/behavioral/', runner_manifests: [MANIFEST],
    assignment: { capabilities: [{ capability_id: 'feature_12', case_marker: 'ubc_0123456789ab' }] },
    feature: { feature_id: 12, title: 'Refunds', status: 'red' }, feature_tag: 'unitbob_feature_12',
    knowledge: '# Refunds\n', knowledge_digest: 'k', scenarios: SCENARIOS, main_suite: 'not_built',
  };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// The feature's files as `tests-prepare` and the host left them: the request,
// the answer with bare paths, and the two files on disk.
function prepared(projectRoot: string): void {
  const request: TestsRequest = {
    project_root: projectRoot, recipe: { name: 'feature_tests', version: 'v', text: 't' },
    feature: { feature_id: 12, title: 'Refunds', status: 'red' }, feature_tag: 'unitbob_feature_12',
    assignment: { capabilities: [] }, scenarios: SCENARIOS, knowledge_path: knowledgePath(projectRoot, 12), knowledge_digest: 'k',
    runner: 'cucumber', runner_manifest: MANIFEST, main_suite: 'not_built',
    feature_path: featureFeaturePath(12), steps_path: featureStepsPath(12, 'cucumber'), output_path: testsOutputPath(projectRoot, 12),
  };
  write(testsRequestPath(projectRoot, 12), JSON.stringify(request));
  write(join(projectRoot, featureFeaturePath(12)), 'Feature: Refunds\n');
  write(join(projectRoot, featureStepsPath(12, 'cucumber')), "Given('a paid order') { }\n");
  write(testsOutputPath(projectRoot, 12), JSON.stringify({
    suite_file: { path: featureFeaturePath(12), support_files: [{ path: featureStepsPath(12, 'cucumber') }] },
    runner_manifest: MANIFEST,
    test_metadata: { capabilities: [{ capability_id: 'feature_12', status: 'covered' }] },
  }));
}

test('tests-review-prepare writes the reviewer’s request in the main suite’s shape, plus the knowledge path and the scenarios', async () => {
  const projectRoot = tmpProject();
  prepared(projectRoot);
  const out: string[] = [];

  await testsReviewPrepare(config(projectRoot), ['12'], {
    getTestsPacket: async () => packet(),
    stdout: { write: (c: string) => { out.push(c); return true; } },
  });

  const written = JSON.parse(readFileSync(testsReviewRequestPath(projectRoot, 12), 'utf8'));
  const suite_file = {
    path: featureFeaturePath(12), content: 'Feature: Refunds\n',
    support_files: [{ path: featureStepsPath(12, 'cucumber'), content: "Given('a paid order') { }\n" }],
  };
  assert.deepEqual(Object.keys(written).sort(), ['candidate_digest', 'capabilities', 'knowledge_path', 'output_path', 'scenarios', 'suite_file']);
  // The same digest `put-tests` binds the review to, over the same bytes.
  assert.equal(written.candidate_digest, suiteCandidateDigest({ suite_kind: 'behavioral', suite_file, runner_manifest: MANIFEST }));
  assert.deepEqual(written.suite_file, suite_file);
  assert.deepEqual(written.capabilities, [{ capability_id: 'feature_12', status: 'covered' }]);
  assert.equal(written.knowledge_path, knowledgePath(projectRoot, 12));
  assert.deepEqual(written.scenarios, SCENARIOS);
  assert.equal(written.output_path, testsReviewOutputPath(projectRoot, 12));
  assert.equal(
    out.join(''),
    `Feature review request written to ${testsReviewRequestPath(projectRoot, 12)}\n` +
      `Next: have the independent reviewer write bdd_quality_review to ${testsReviewOutputPath(projectRoot, 12)}, then run \`unitbob put-tests 12\`.\n`,
  );
});

// The server says no at `intent` (no scenarios to review) and at `done` (the
// checks are guardrails now) in its own words; they are let through as they
// are, and nothing is written.
test('tests-review-prepare lets the server’s 409 through in its own words, writing nothing', async () => {
  const projectRoot = tmpProject();
  prepared(projectRoot);
  const refusal = new WireError('GET tests_packet failed: 409 — This feature is finished; its checks are part of the guardrails now. To change them, act on the red lamp on the map.');

  await assert.rejects(
    () => testsReviewPrepare(config(projectRoot), ['12'], { getTestsPacket: async () => { throw refusal; }, stdout: { write: () => true } }),
    (err: unknown) => err === refusal,
  );
  assert.equal(existsSync(testsReviewRequestPath(projectRoot, 12)), false);
});

test('tests-review-prepare needs the feature id, the request and the answer', async () => {
  const projectRoot = tmpProject();
  const deps = { getTestsPacket: async () => packet(), stdout: { write: () => true } };
  await assert.rejects(() => testsReviewPrepare(config(projectRoot), [], deps), /Usage: unitbob tests-review-prepare <feature_id>/);
  await assert.rejects(() => testsReviewPrepare(config(projectRoot), ['12'], deps), /tests-request\.json not found/);
});
