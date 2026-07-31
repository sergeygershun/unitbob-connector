import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  candidateRunPath,
  outputPath,
  reviewOutputPath,
  suiteCandidateDigest,
  writeBehavioralReviewRequest,
  writeSuiteBuildRequest,
  type HostBranchOutput,
  type SuiteBuildBranch,
} from '../src/files/suiteBuild.ts';
import { classifyPublication, putSuiteBuild } from '../src/verbs/putSuiteBuild.ts';
import type { Config } from '../src/config.ts';
import type { SuiteBuildItem, SuiteBuildResult } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-put-suite-build-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

function branches(): SuiteBuildBranch[] {
  return [
    {
      suite_kind: 'structural', source_digest: 'map-d', path_root: '.unitbob/structural/',
      recipe: { name: 'generate', version: 'g1', text: 'g' }, assignment: {},
    },
    {
      suite_kind: 'behavioral', source_digest: 'surface-d', path_root: '.unitbob/behavioral/',
      recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' }, assignment: {},
    },
  ];
}

function writeTask(projectRoot: string): void {
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeSuiteBuildRequest(projectRoot, branches());
}

function structuralBranch(): Record<string, unknown> {
  return {
    suite_kind: 'structural',
    suite_file: {
      path: '.unitbob/structural/architecture_map_contracts_spec.rb',
      content: "require_relative 'unitbob_helper'\n\nRSpec.describe 'x' do\nend\n",
    },
    runner_manifest: { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' },
    test_metadata: { capabilities: [{ interface_id: 'billing_charge', status: 'unguarded', reason: 'no boundary' }] },
  };
}

function behavioralBranch(): Record<string, unknown> {
  return {
    suite_kind: 'behavioral',
    suite_file: {
      path: '.unitbob/behavioral/features/surface_contracts.feature',
      content: 'Feature: x\n',
      support_files: [{ path: '.unitbob/behavioral/step_definitions/surface_steps.rb', content: '# steps\n' }],
    },
    runner_manifest: {
      language: 'ruby', framework: 'cucumber', result_format: 'cucumber_messages',
      runner: 'cucumber', package_manager: 'bundler', runner_version: '9.2.0',
    },
    test_metadata: { capabilities: [{ capability_id: 'checkout', status: 'unguarded', reason: 'needs a live provider' }] },
  };
}

function writeReview(projectRoot: string, behavioral: Record<string, unknown>): void {
  writeBehavioralReviewRequest(
    projectRoot,
    behavioral as unknown as HostBranchOutput,
    { revision: 'candidate-sha', run_result: 'raw machine report' },
  );
  writeFileSync(reviewOutputPath(projectRoot), JSON.stringify({
    candidate_digest: suiteCandidateDigest(behavioral as unknown as HostBranchOutput),
    bdd_quality_review: { reviewer: 'independent', scenario_reviews: [] },
    known_defect_probe: { status: 'not_supplied' },
  }));
}

const okResults: SuiteBuildResult[] = [
  { suite_kind: 'structural', status: 'created', suite_digest: 's', counts: { covered: 1 } },
  { suite_kind: 'behavioral', status: 'created', suite_digest: 'b', counts: { covered: 1 } },
];

test('put-suite-build uploads both branches, echoing each source_digest from the task', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const behavioral = behavioralBranch();
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [structuralBranch(), behavioral] }));
  writeReview(projectRoot, behavioral);

  let uploaded: SuiteBuildItem[] = [];
  await putSuiteBuild(config(projectRoot), [], {
    putSuiteBuilds: async (items) => { uploaded = items; return okResults; },
    stdout: { write: () => true },
  });

  assert.deepEqual(uploaded.map((item) => item.suite_kind), ['structural', 'behavioral']);
  assert.equal(uploaded[0].source_digest, 'map-d');
  assert.equal(uploaded[1].source_digest, 'surface-d');
  assert.deepEqual(uploaded[0].artifacts!.runner_manifest, structuralBranch().runner_manifest);
  assert.deepEqual(
    (uploaded[1].artifacts!.suite_file as Record<string, unknown>).support_files,
    (behavioralBranch().suite_file as Record<string, unknown>).support_files,
  );
  assert.deepEqual(
    (uploaded[1].artifacts!.test_metadata as Record<string, unknown>).bdd_quality_review,
    {
      reviewer: 'independent',
      scenario_reviews: [],
      candidate_digest: suiteCandidateDigest(behavioral as unknown as HostBranchOutput),
    },
  );
});

test('put-suite-build relays a per-branch build_error without rolling back the peer', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  writeFileSync(
    outputPath(projectRoot),
    JSON.stringify({
      branches: [structuralBranch(), { suite_kind: 'behavioral', build_error: { message: 'cucumber is not installable here' } }],
    }),
  );

  let uploaded: SuiteBuildItem[] = [];
  await putSuiteBuild(config(projectRoot), [], {
    putSuiteBuilds: async (items) => { uploaded = items; return okResults; },
    stdout: { write: () => true },
  });

  assert.equal(uploaded[0].artifacts !== undefined, true);
  assert.equal(uploaded[1].build_error?.message, 'cucumber is not installable here');
  assert.equal(uploaded[1].source_digest, 'surface-d');
});

test('put-suite-build refuses to upload when the host output is unparseable', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  writeFileSync(outputPath(projectRoot), 'sorry, here are your tests:');

  let uploaded = false;
  await assert.rejects(
    () =>
      putSuiteBuild(config(projectRoot), [], {
        putSuiteBuilds: async () => { uploaded = true; throw new Error('should not upload'); },
        stdout: { write: () => true },
      }),
    /is not valid JSON/,
  );
  assert.equal(uploaded, false);
});

test('put-suite-build refuses a behavioral review embedded by the suite generator', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const behavioral = behavioralBranch();
  behavioral.test_metadata = {
    capabilities: [],
      bdd_quality_review: { reviewer: 'independent', scenario_reviews: [] },
      known_defect_probe: { status: 'not_supplied' },
      known_defect_context: { status: 'not_supplied' },
  };
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [structuralBranch(), behavioral] }));

  let uploaded = false;
  await assert.rejects(
    () => putSuiteBuild(config(projectRoot), [], {
      putSuiteBuilds: async () => { uploaded = true; return okResults; },
      stdout: { write: () => true },
    }),
    /separate review artifact|suite-review-prepare/i,
  );
  assert.equal(uploaded, false);
});

// The server strips five keys before it recomputes the digest, so a generator
// that writes any of them makes the two sides hash different objects. Caught
// here it names the real cause; caught by the server it reads as "the review is
// about a different candidate".
test('put-suite-build names the generator-owned run report the server would strip from the digest', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const behavioral = behavioralBranch();
  behavioral.test_metadata = {
    capabilities: [],
    candidate_run: { revision: 'abc123', run_result: '{}' },
  };
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [structuralBranch(), behavioral] }));

  let uploaded = false;
  await assert.rejects(
    () => putSuiteBuild(config(projectRoot), [], {
      putSuiteBuilds: async () => { uploaded = true; return okResults; },
      stdout: { write: () => true },
    }),
    /found candidate_run in test_metadata/i,
  );
  assert.equal(uploaded, false);
});

// A candidate that moved after it was reviewed. The connector's run evidence
// agrees with the review, so the reader is told their suite changed — not sent
// to audit a review that was right when it was written.
test('put-suite-build refuses a review created before the behavioral runner manifest changed', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const behavioral = behavioralBranch();
  writeReview(projectRoot, behavioral);
  behavioral.runner_manifest = { ...(behavioral.runner_manifest as Record<string, unknown>), runner_version: '10.0.0' };
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [structuralBranch(), behavioral] }));

  let uploaded = false;
  await assert.rejects(
    () => putSuiteBuild(config(projectRoot), [], {
      putSuiteBuilds: async () => { uploaded = true; return okResults; },
      stdout: { write: () => true },
    }),
    /it has changed since — re-run/i,
  );
  assert.equal(uploaded, false);
});

// A review about some other candidate entirely: it agrees with neither the suite
// on disk nor the run the connector made. That is the reviewer's problem, and
// the wording stays the blunt one.
test('put-suite-build refuses a review that belongs to another candidate', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const behavioral = behavioralBranch();
  writeReview(projectRoot, behavioral);
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [structuralBranch(), behavioral] }));
  writeFileSync(reviewOutputPath(projectRoot), JSON.stringify({
    candidate_digest: 'a digest from a suite this project never built',
    bdd_quality_review: { reviewer: 'independent', scenario_reviews: [] },
    known_defect_probe: { status: 'not_supplied' },
  }));

  await assert.rejects(
    () => putSuiteBuild(config(projectRoot), [], {
      putSuiteBuilds: async () => { throw new Error('must not upload'); },
      stdout: { write: () => true },
    }),
    /does not review the current behavioral suite candidate/i,
  );
});

// The connector writes this file itself, always with the defect choice it was
// given. Missing means the file is damaged — reading it as "no defect was
// supplied" would silently skip the fixed-revision evidence check below it.
test('put-suite-build refuses run evidence that records no defect choice', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const behavioral = behavioralBranch();
  writeReview(projectRoot, behavioral);
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [structuralBranch(), behavioral] }));
  const evidence = JSON.parse(readFileSync(candidateRunPath(projectRoot), 'utf8'));
  delete evidence.known_defect_context;
  writeFileSync(candidateRunPath(projectRoot), JSON.stringify(evidence));

  await assert.rejects(
    () => putSuiteBuild(config(projectRoot), [], {
      putSuiteBuilds: async () => { throw new Error('must not upload'); },
      stdout: { write: () => true },
    }),
    /records no known_defect_context/i,
  );
});

test('put-suite-build refuses not_supplied when suite-prepare recorded a known defect', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeSuiteBuildRequest(projectRoot, branches(), {
    status: 'supplied', defect: 'Report uses a missing method',
  });
  const behavioral = behavioralBranch();
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [structuralBranch(), behavioral] }));
  writeReview(projectRoot, behavioral);

  await assert.rejects(
    () => putSuiteBuild(config(projectRoot), [], {
      putSuiteBuilds: async () => { throw new Error('must not upload'); },
      stdout: { write: () => true },
    }),
    /known defect.*not_supplied/i,
  );
});

test('put-suite-build rejects a behavioral branch whose file escapes the behavioral root', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const escaped = behavioralBranch();
  (escaped.suite_file as Record<string, unknown>).path = 'features/pwned.feature';
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [structuralBranch(), escaped] }));

  let uploaded = false;
  await assert.rejects(
    () =>
      putSuiteBuild(config(projectRoot), [], {
        putSuiteBuilds: async () => { uploaded = true; throw new Error('should not upload'); },
        stdout: { write: () => true },
      }),
    /\.unitbob\/behavioral\//,
  );
  assert.equal(uploaded, false);
});

test('put-suite-build rejects the legacy spec_rb shape', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  writeFileSync(
    outputPath(projectRoot),
    JSON.stringify({ branches: [{ suite_kind: 'structural', spec_rb: "require 'rails_helper'\n" }] }),
  );

  await assert.rejects(
    () => putSuiteBuild(config(projectRoot), [], { putSuiteBuilds: async () => okResults, stdout: { write: () => true } }),
    /legacy spec_rb/,
  );
});

// One rule for "was this published?", shared by the printed line and the run that
// follows it. A status this connector has never seen used to print as
// `structural: quarantined (abc).` — a line carrying a digest and no hint of
// trouble — immediately above "no suite was published, so nothing was run".
test('put-suite-build reports an unrecognised status as not published, quoting the server', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [structuralBranch()] }));

  let printed = '';
  const results = await putSuiteBuild(config(projectRoot), [], {
    putSuiteBuilds: async () => [{ suite_kind: 'structural', status: 'quarantined', suite_digest: 'abc' }],
    stdout: { write: (chunk: string) => { printed += chunk; return true; } },
  });

  assert.match(printed, /structural: not published — the server answered "quarantined"\./);
  assert.doesNotMatch(printed, /abc/, 'an unpublished branch must not show an identity to run');
  assert.deepEqual(classifyPublication(results), { digests: [], unpublished: ['structural'] });
});

test('put-suite-build keeps the existing wording for a branch the host could not build', async () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  writeFileSync(
    outputPath(projectRoot),
    JSON.stringify({ branches: [{ suite_kind: 'structural', build_error: { message: 'no supported stack here' } }] }),
  );

  let printed = '';
  await putSuiteBuild(config(projectRoot), [], {
    putSuiteBuilds: async () => [{ suite_kind: 'structural', status: 'build_error', error: 'no supported stack here' }],
    stdout: { write: (chunk: string) => { printed += chunk; return true; } },
  });

  assert.match(printed, /structural: not published — no supported stack here\./);
});
