import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputPath, reviewRequestPath, suiteCandidateDigest, writeSuiteBuildRequest } from '../src/files/suiteBuild.ts';
import { requestDigest, workerPlanDigest, workerPlanPath } from '../src/files/workerPlan.ts';
import { candidateUnion, suiteReviewPrepare } from '../src/verbs/suiteReviewPrepare.ts';
import { FeatureFilesChangedError } from '../src/files/behavioral.ts';
import type { FeatureSuiteItem } from '../src/wire.ts';
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
    getSuiteIndex: async () => ({ suites: [], feature_suites: [] }),
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

test('a planned candidate gives the reviewer its original assignment and exact behavioral plan', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-suite-review-plan-'));
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  const assignment = { capabilities: [{ capability_id: 'billing' }] };
  writeSuiteBuildRequest(projectRoot, [{
    suite_kind: 'behavioral', source_digest: 'surface-d', path_root: '.unitbob/behavioral/',
    recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' }, assignment,
  }], { status: 'not_supplied' });
  const worker = {
    branch: 'behavioral', worker_id: 'b1', capability_ids: ['billing'], promises: ['charge card'],
    planned_cases: ['successful charge'], source_paths: ['app/payments.rb'],
    owned_paths: ['.unitbob/behavioral/features/billing.feature'],
    harness_path: '.unitbob/behavioral/step_definitions/00_unitbob_world.rb',
    done_when: 'done',
  };
  writeFileSync(workerPlanPath(projectRoot), JSON.stringify({ request_digest: requestDigest(projectRoot), workers: [worker] }));
  const behavioral = {
    suite_kind: 'behavioral',
    suite_file: { path: '.unitbob/behavioral/features/billing.feature', content: 'Feature: Billing\n' },
    runner_manifest: { runner: 'cucumber' },
    test_metadata: { worker_plan_digest: workerPlanDigest(projectRoot), capabilities: [{ capability_id: 'billing' }] },
  };
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [behavioral] }));

  await suiteReviewPrepare({ server: 'https://host', repoId: 3, projectRoot }, [], {
    getSuiteIndex: async () => ({ suites: [], feature_suites: [] }),
    runCandidate: async () => ({ revision: 'sha', run_result: 'raw' }),
    stdout: { write: () => true },
  });

  const request = JSON.parse(readFileSync(reviewRequestPath(projectRoot), 'utf8'));
  assert.deepEqual(request.behavioral_assignment, assignment);
  assert.deepEqual(request.worker_plan, [worker]);
  assert.equal(request.plan_digest, workerPlanDigest(projectRoot));
});

test('a local bounded plan cannot silently fall back to the legacy review contract', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-suite-review-missing-plan-digest-'));
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeSuiteBuildRequest(projectRoot, [{
    suite_kind: 'behavioral', source_digest: 'surface-d', path_root: '.unitbob/behavioral/',
    recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' },
    assignment: { capabilities: [{ capability_id: 'billing' }] },
  }], { status: 'not_supplied' });
  writeFileSync(workerPlanPath(projectRoot), JSON.stringify({ request_digest: requestDigest(projectRoot), workers: [] }));
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [{
    suite_kind: 'behavioral',
    suite_file: { path: '.unitbob/behavioral/features/billing.feature', content: 'Feature: Billing\n' },
    runner_manifest: { runner: 'cucumber' },
    test_metadata: { capabilities: [{ capability_id: 'billing' }] },
  }] }));

  await assert.rejects(
    suiteReviewPrepare({ server: 'https://host', repoId: 3, projectRoot }, [], {
      getSuiteIndex: async () => ({ suites: [], feature_suites: [] }),
    runCandidate: async () => ({ revision: 'sha', run_result: 'raw' }),
      stdout: { write: () => true },
    }),
    /worker_plan_digest is required/,
  );
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
    getSuiteIndex: async () => ({ suites: [], feature_suites: [] }),
    runCandidate: async (_root, _output, _features, revision) => {
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

// The warning has to reach the user *before* the candidate is run, because the
// run materializes the answer and that is when the forgotten file is deleted.
// Saying it afterwards would describe a file that no longer exists.
test('suite-review-prepare warns about the forgotten files before it runs the candidate', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-suite-review-forgot-'));
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral', 'features', 'support'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral', 'step_definitions'), { recursive: true });
  writeFileSync(join(projectRoot, '.unitbob', 'behavioral', 'features', 'support', 'env.rb'), '# forgotten\n');
  writeFileSync(join(projectRoot, '.unitbob', 'behavioral', 'Gemfile'), "source 'x'\n");
  writeSuiteBuildRequest(projectRoot, [{
    suite_kind: 'behavioral', source_digest: 'surface-d', path_root: '.unitbob/behavioral/',
    recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' }, assignment: {},
  }], { status: 'not_supplied' });
  writeFileSync(outputPath(projectRoot), JSON.stringify({
    branches: [{
      suite_kind: 'behavioral',
      suite_file: {
        path: '.unitbob/behavioral/features/surface_contracts.feature',
        content: 'Feature: Product behavior\n',
        support_files: [{ path: '.unitbob/behavioral/step_definitions/steps.rb', content: '# steps\n' }],
      },
      runner_manifest: { runner: 'cucumber' },
      test_metadata: { capabilities: [{ capability_id: 'billing', status: 'covered' }] },
    }],
  }));
  const said: string[] = [];

  await suiteReviewPrepare({ server: 'https://host', repoId: 3, projectRoot }, [], {
    getSuiteIndex: async () => ({ suites: [], feature_suites: [] }),
    runCandidate: async () => {
      said.push('<the candidate ran>');
      return { revision: 'sha', run_result: 'raw' };
    },
    stdout: { write: (chunk: string) => said.push(chunk) },
  });

  const warning = said.findIndex((line) => line.includes('will delete them'));
  assert.ok(warning >= 0, `no warning in ${JSON.stringify(said)}`);
  assert.match(said[warning], /features\/support\/env\.rb/);
  // The runner environment at the suite root is not the answer's to list.
  assert.doesNotMatch(said[warning], /Gemfile/);
  assert.ok(warning < said.indexOf('<the candidate ran>'), 'the warning must come before the run');
});

// Spec 34-6, criterion 2.1. The review-round counter is gone: review is the only
// thing in either run that caught a lost business outcome, and 34-3's "exactly
// one reviewer" is what makes a round cheap enough not to count. What is left
// here is that `suite-review-prepare` writes its request and says nothing about
// ceilings at all.
function reviewProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-review-rounds-'));
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeSuiteBuildRequest(projectRoot, [{
    suite_kind: 'behavioral', source_digest: 'surface-d', path_root: '.unitbob/behavioral/',
    recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' }, assignment: {},
  }], { status: 'not_supplied' });
  writeFileSync(outputPath(projectRoot), JSON.stringify({
    branches: [{
      suite_kind: 'behavioral',
      suite_file: {
        path: '.unitbob/behavioral/features/surface_contracts.feature',
        content: 'Feature: Product behavior\n',
        support_files: [{ path: '.unitbob/behavioral/step_definitions/steps.rb', content: '# steps\n' }],
      },
      runner_manifest: { runner: 'cucumber' },
      test_metadata: { capabilities: [{ capability_id: 'billing', status: 'covered' }] },
    }],
  }));
  return projectRoot;
}

async function prepareReview(projectRoot: string): Promise<string> {
  let output = '';
  await suiteReviewPrepare({ server: 'https://host', repoId: 3, projectRoot }, [], {
    getSuiteIndex: async () => ({ suites: [], feature_suites: [] }),
    runCandidate: async () => ({ revision: 'sha', run_result: 'raw report' }),
    stdout: { write: (chunk) => { output += chunk; return true; } },
  });
  return output;
}

test('preparing a review says nothing about rounds or ceilings, however often it runs', async () => {
  const projectRoot = reviewProject();

  for (let round = 0; round < 4; round += 1) {
    const printed = await prepareReview(projectRoot);
    assert.doesNotMatch(printed, /last round|budget|ceiling/i);
    assert.match(printed, /Behavioral review request written/);
  }

  assert.equal(existsSync(reviewRequestPath(projectRoot)), true);
  const request = JSON.parse(readFileSync(reviewRequestPath(projectRoot), 'utf8'));
  assert.match(request.output_path, /behavioral_review\.json$/);
});

// Spec 52-4, AC 1.8. Reviewing the candidate materialises it, and until now
// that wiped a feature's checks from the disk with it — including steps the
// host had rewired and not saved. The candidate now goes on disk as the same
// union `check` writes, so the same stop applies before anything is touched,
// and the candidate's run leaves the feature tags out as everywhere else.
function featureSuite(id: number): FeatureSuiteItem {
  return {
    feature_id: id, title: `Feature ${id}`, feature_tag: `unitbob_feature_${id}`, suite_digest: `feat-${id}`,
    suite_file: {
      path: `.unitbob/behavioral/features/feature_${id}.feature`, content: `Feature: ${id}\n`,
      support_files: [{ path: `.unitbob/behavioral/step_definitions/feature_${id}_steps.rb`, content: `# ${id}\n` }],
    },
    runner_manifest: { runner: 'cucumber' },
  };
}

test('suite-review-prepare stops on a feature file changed on disk before running or touching anything', async () => {
  const projectRoot = reviewProject();
  const rewired = join(projectRoot, '.unitbob', 'behavioral', 'step_definitions', 'feature_12_steps.rb');
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral', 'step_definitions'), { recursive: true });
  writeFileSync(rewired, '# 12, rewired\n');
  let ran = false;

  await assert.rejects(
    () => suiteReviewPrepare({ server: 'https://host', repoId: 3, projectRoot }, [], {
      getSuiteIndex: async () => ({ suites: [], feature_suites: [featureSuite(12)] }),
      runCandidate: async () => { ran = true; return { revision: 'sha', run_result: 'raw' }; },
      stdout: { write: () => true },
    }),
    (err: unknown) => err instanceof FeatureFilesChangedError && /Feature 12/.test(err.message),
  );
  assert.equal(ran, false);
  assert.equal(readFileSync(rewired, 'utf8'), '# 12, rewired\n');
  assert.equal(existsSync(reviewRequestPath(projectRoot)), false);
});

test('the candidate goes on disk as the union with every feature’s checks, and runs with their tags excluded', () => {
  const projectRoot = reviewProject();
  const behavioral = JSON.parse(readFileSync(outputPath(projectRoot), 'utf8')).branches[0];

  const union = candidateUnion(projectRoot, behavioral, [featureSuite(12), featureSuite(15)]);

  assert.ok(union.mainPath.endsWith('surface_contracts.feature'));
  assert.deepEqual(union.excludeTags, ['unitbob_feature_12', 'unitbob_feature_15']);
  assert.ok(existsSync(join(projectRoot, '.unitbob', 'behavioral', 'features', 'feature_15.feature')));
  assert.ok(existsSync(join(projectRoot, '.unitbob', 'behavioral', 'step_definitions', 'steps.rb')));
});

test('the candidate’s forgotten-file warning does not name the feature files the union keeps', async () => {
  const projectRoot = reviewProject();
  candidateUnion(projectRoot, JSON.parse(readFileSync(outputPath(projectRoot), 'utf8')).branches[0], [featureSuite(12)]);
  const said: string[] = [];

  await suiteReviewPrepare({ server: 'https://host', repoId: 3, projectRoot }, [], {
    getSuiteIndex: async () => ({ suites: [], feature_suites: [featureSuite(12)] }),
    runCandidate: async () => ({ revision: 'sha', run_result: 'raw' }),
    stdout: { write: (chunk: string) => said.push(chunk) },
  });

  assert.equal(said.some((line) => line.includes('will delete them')), false, JSON.stringify(said));
});
