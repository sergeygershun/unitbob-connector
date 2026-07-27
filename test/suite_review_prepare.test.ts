import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputPath, reviewRequestPath, suiteCandidateDigest, writeSuiteBuildRequest } from '../src/files/suiteBuild.ts';
import { suiteReviewPrepare } from '../src/verbs/suiteReviewPrepare.ts';
import type { Config } from '../src/config.ts';

test('suite-review-prepare binds a separate review request to the behavioral candidate', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-suite-review-'));
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeSuiteBuildRequest(projectRoot, [{
    suite_kind: 'behavioral', source_digest: 'surface-d', path_root: '.unitbob/behavioral/',
    recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' }, assignment: {},
  }], { status: 'supplied', defect: 'Report uses a missing method' });
  const behavioral = {
    suite_kind: 'behavioral',
    suite_file: {
      path: '.unitbob/behavioral/features/surface_contracts.feature',
      content: 'Feature: Product behavior\n',
      support_files: [{ path: '.unitbob/behavioral/step_definitions/steps.rb', content: '# steps\n' }],
    },
    runner_manifest: { runner: 'cucumber' },
    test_metadata: { capabilities: [{ capability_id: 'billing', status: 'covered' }] },
  };
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [behavioral] }));
  const config: Config = { server: 'https://host', repoId: 3, projectRoot };

  await suiteReviewPrepare(config, [], {
    runCandidate: async () => ({ revision: 'defect-sha', run_result: 'raw machine report' }),
    stdout: { write: () => true },
  });

  const request = JSON.parse(readFileSync(reviewRequestPath(projectRoot), 'utf8'));
  assert.equal(request.candidate_digest, suiteCandidateDigest(behavioral));
  assert.deepEqual(request.suite_file, behavioral.suite_file);
  assert.deepEqual(request.capabilities, behavioral.test_metadata.capabilities);
  assert.deepEqual(request.known_defect_context, { status: 'supplied', defect: 'Report uses a missing method' });
  assert.deepEqual(request.candidate_run, {
    candidate_digest: suiteCandidateDigest(behavioral),
    revision: 'defect-sha',
    run_result: 'raw machine report',
  });
  assert.match(request.output_path, /behavioral_review\.json$/);
});

test('suite-review-prepare records a separate machine run for a supplied fixed revision', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-suite-review-fixed-'));
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeSuiteBuildRequest(projectRoot, [{
    suite_kind: 'behavioral', source_digest: 'surface-d', path_root: '.unitbob/behavioral/',
    recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' }, assignment: {},
  }], {
    status: 'supplied', defect: 'Report uses a missing method', fixed_revision: 'fixed-sha',
  });
  const behavioral = {
    suite_kind: 'behavioral',
    suite_file: {
      path: '.unitbob/behavioral/features/surface_contracts.feature',
      content: 'Feature: Product behavior\n',
      support_files: [{ path: '.unitbob/behavioral/step_definitions/steps.rb', content: '# steps\n' }],
    },
    runner_manifest: { runner: 'cucumber' },
    test_metadata: { capabilities: [{ capability_id: 'billing', status: 'covered' }] },
  };
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [behavioral] }));
  const revisions: Array<string | undefined> = [];

  await suiteReviewPrepare({ server: 'https://host', repoId: 3, projectRoot }, [], {
    runCandidate: async (_root, _output, revision) => {
      revisions.push(revision);
      return { revision: revision ?? 'defect-sha', run_result: revision ? 'fixed raw report' : 'defect raw report' };
    },
    stdout: { write: () => true },
  });

  const request = JSON.parse(readFileSync(reviewRequestPath(projectRoot), 'utf8'));
  assert.deepEqual(revisions, [undefined, 'fixed-sha']);
  assert.deepEqual(request.fixed_candidate_run, {
    candidate_digest: suiteCandidateDigest(behavioral),
    revision: 'fixed-sha',
    run_result: 'fixed raw report',
  });
});
