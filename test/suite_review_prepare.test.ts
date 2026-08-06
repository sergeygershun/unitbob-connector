import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// Spec 34-2, criterion 5. Three review rounds on a2time were expensive because
// of the number of reviewers, not the number of rounds — 5 slices x 3 rounds =
// 15 launches. With one reviewer, two rounds is two launches. The counter is
// what makes the number in `budget.review_rounds` mean anything.
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
    runCandidate: async () => ({ revision: 'sha', run_result: 'raw report' }),
    stdout: { write: (chunk) => { output += chunk; return true; } },
  });
  return output;
}

test('a review round within the budget says nothing about rounds', async () => {
  const projectRoot = reviewProject();

  assert.doesNotMatch(await prepareReview(projectRoot), /last round/i);
  assert.doesNotMatch(await prepareReview(projectRoot), /last round/i);
});

// Not a refusal. A refusal here is the autobrella deadlock rebuilt on a
// different number: the round is capped, so the branch could never publish, so
// the work is lost again. The message says the opposite — publish what you have,
// and record the objections as verdicts.
test('a review round past the budget still writes the request, and says it is the last', async () => {
  const projectRoot = reviewProject();
  await prepareReview(projectRoot);
  await prepareReview(projectRoot);

  const third = await prepareReview(projectRoot);

  assert.match(third, /last round/i);
  assert.match(third, /publish what you have/i);
  assert.match(third, /does_not_pass/);
  assert.equal(existsSync(reviewRequestPath(projectRoot)), true);
  const request = JSON.parse(readFileSync(reviewRequestPath(projectRoot), 'utf8'));
  assert.match(request.output_path, /behavioral_review\.json$/);
});

// The count is on disk, not in the agent's memory: the loop it bounds spans
// separate processes, each started by a fresh `npx`.
test('the review round count survives the process that made it', async () => {
  const projectRoot = reviewProject();
  await prepareReview(projectRoot);
  await prepareReview(projectRoot);

  const spent = JSON.parse(
    readFileSync(join(projectRoot, '.unitbob', 'suite-build', 'budget-spent.json'), 'utf8'),
  );
  assert.equal(spent.review_rounds, 2);
});

// An old connector wrote the request; a new one is reading it. There is no
// ceiling to enforce, so the counter has nothing to say.
test('a request with no budget block leaves the counter silent', async () => {
  const projectRoot = reviewProject();
  const path = join(projectRoot, '.unitbob', 'suite-build', 'request.json');
  const request = JSON.parse(readFileSync(path, 'utf8'));
  delete request.budget;
  writeFileSync(path, JSON.stringify(request));

  for (let round = 0; round < 4; round += 1) {
    assert.doesNotMatch(await prepareReview(projectRoot), /last round/i);
  }
});
