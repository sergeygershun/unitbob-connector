import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  movePreviousRunAside,
  outputPath,
  readHostSuiteOutputs,
  readSuiteBuildRequest,
  recipeNameFor,
  requestPath,
  suiteCandidateDigest,
  writeSuiteBuildRequest,
  type SuiteBuildBranch,
} from '../src/files/suiteBuild.ts';
import { behavioralWorldFor, filesLostOnMaterialize } from '../src/files/behavioral.ts';
import type { SuitePacket } from '../src/wire.ts';

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'unitbob-suite-build-files-'));
  mkdirSync(join(dir, '.unitbob', 'suite-build'), { recursive: true });
  return dir;
}

function branches(): SuiteBuildBranch[] {
  return [
    {
      suite_kind: 'structural', source_digest: 'map-d', path_root: '.unitbob/structural/',
      recipe: { name: 'generate', version: 'g1', text: 'g' }, assignment: { blocks: [] },
    },
    {
      suite_kind: 'behavioral', source_digest: 'surface-d', path_root: '.unitbob/behavioral/',
      recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' }, assignment: { capabilities: [] },
    },
  ];
}

function structuralBranch(): Record<string, unknown> {
  return {
    suite_kind: 'structural',
    suite_file: { path: '.unitbob/structural/architecture_map_contracts_spec.rb', content: "require 'x'\n" },
    runner_manifest: { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' },
    test_metadata: { capabilities: [] },
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
    test_metadata: { capabilities: [] },
  };
}

function writeTask(projectRoot: string): void {
  writeSuiteBuildRequest(projectRoot, branches());
}

function writeOutput(projectRoot: string, output: unknown): string {
  const path = outputPath(projectRoot);
  writeFileSync(path, typeof output === 'string' ? output : JSON.stringify(output));
  return path;
}

test('writes and round-trips the two-branch suite build request', () => {
  const projectRoot = tmpProject();
  const request = writeSuiteBuildRequest(projectRoot, branches());

  assert.equal(request.output_path, outputPath(projectRoot));
  assert.equal(existsSync(requestPath(projectRoot)), true);
  assert.deepEqual(readSuiteBuildRequest(projectRoot), request);
  assert.deepEqual(request.branches.map((branch) => branch.suite_kind), ['structural', 'behavioral']);
});

// Spec 34-6, criterion 2.3, and its edge case. The request carries no `budget`
// any more; a request an older connector wrote still carries one, and reading it
// must not turn a stale field into a failure. There is nothing left to enforce,
// so the field is simply not read.
test('the request carries no run budget, and an old one carrying it still reads', () => {
  const projectRoot = tmpProject();
  writeSuiteBuildRequest(projectRoot, branches());

  const written = JSON.parse(readFileSync(requestPath(projectRoot), 'utf8'));
  assert.equal(written.budget, undefined);

  written.budget = { workers: 4, review_rounds: 2, repair_rounds: 8 };
  writeFileSync(requestPath(projectRoot), `${JSON.stringify(written, null, 2)}\n`);

  const read = readSuiteBuildRequest(projectRoot);
  assert.deepEqual(read.branches.map((branch) => branch.suite_kind), ['structural', 'behavioral']);
});

test('reads both branch outputs, keeping each artifact envelope', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const path = writeOutput(projectRoot, { branches: [structuralBranch(), behavioralBranch()] });

  const outputs = readHostSuiteOutputs(path, readSuiteBuildRequest(projectRoot));
  assert.deepEqual(outputs.map((output) => output.suite_kind), ['structural', 'behavioral']);
  assert.deepEqual(outputs[1].suite_file, behavioralBranch().suite_file);
});

test('relays a branch build_error', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const path = writeOutput(projectRoot, {
    branches: [structuralBranch(), { suite_kind: 'behavioral', build_error: { message: 'no cucumber here' } }],
  });

  const outputs = readHostSuiteOutputs(path, readSuiteBuildRequest(projectRoot));
  assert.equal(outputs[1].build_error?.message, 'no cucumber here');
  assert.equal(outputs[1].suite_file, undefined);
});

test('rejects malformed or incomplete branch output', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const request = readSuiteBuildRequest(projectRoot);

  let path = writeOutput(projectRoot, 'I wrote some tests for you');
  assert.throws(() => readHostSuiteOutputs(path, request), /is not valid JSON/);

  path = writeOutput(projectRoot, { branches: [{ ...structuralBranch(), test_metadata: undefined }] });
  assert.throws(() => readHostSuiteOutputs(path, request), /missing test_metadata/);

  path = writeOutput(projectRoot, { branches: [{ ...structuralBranch(), runner_manifest: undefined }] });
  assert.throws(() => readHostSuiteOutputs(path, request), /missing runner_manifest/);

  path = writeOutput(projectRoot, { branches: [{ ...structuralBranch(), suite_kind: 'mystery' }] });
  assert.throws(() => readHostSuiteOutputs(path, request), /unknown suite_kind/);
});

test('takes a file the host already wrote when the branch names it without content', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral', 'features'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral', 'step_definitions'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.unitbob', 'behavioral', 'features', 'surface_contracts.feature'),
    'Feature: from disk\n',
  );
  writeFileSync(
    join(projectRoot, '.unitbob', 'behavioral', 'step_definitions', 'client_management_steps.rb'),
    '# client steps\n',
  );

  const branch = behavioralBranch();
  branch.suite_file = {
    path: '.unitbob/behavioral/features/surface_contracts.feature',
    support_files: [{ path: '.unitbob/behavioral/step_definitions/client_management_steps.rb' }],
  };
  const path = writeOutput(projectRoot, { branches: [branch] });

  const [behavioral] = readHostSuiteOutputs(path, readSuiteBuildRequest(projectRoot));
  const envelope = behavioral.suite_file as { content: string; support_files: { content: string }[] };
  assert.equal(envelope.content, 'Feature: from disk\n');
  assert.equal(envelope.support_files[0].content, '# client steps\n');
});

test('rejects a named file the host never wrote, and empty content', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const request = readSuiteBuildRequest(projectRoot);

  const missing = behavioralBranch();
  missing.suite_file = { path: '.unitbob/behavioral/features/surface_contracts.feature' };
  assert.throws(
    () => readHostSuiteOutputs(writeOutput(projectRoot, { branches: [missing] }), request),
    /no such file exists/,
  );

  const blank = structuralBranch();
  (blank.suite_file as Record<string, unknown>).content = '   ';
  assert.throws(
    () => readHostSuiteOutputs(writeOutput(projectRoot, { branches: [blank] }), request),
    /empty content/,
  );
});

test('refuses a suite file that is a link out of the suite root', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const secret = join(projectRoot, 'private_key');
  writeFileSync(secret, 'ssh-rsa AAAA\n');
  mkdirSync(join(projectRoot, '.unitbob', 'structural'), { recursive: true });
  symlinkSync(secret, join(projectRoot, '.unitbob', 'structural', 'architecture_map_contracts_spec.rb'));

  const branch = structuralBranch();
  branch.suite_file = { path: '.unitbob/structural/architecture_map_contracts_spec.rb' };
  const path = writeOutput(projectRoot, { branches: [branch] });

  assert.throws(() => readHostSuiteOutputs(path, readSuiteBuildRequest(projectRoot)), /resolves outside the suite root/);
});

// A leaf-only symlink check passes this: the file is real, the directory holding
// it is the link.
test('refuses a suite file whose directory is a link out of the suite root', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const outside = join(projectRoot, 'elsewhere');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'architecture_map_contracts_spec.rb'), '# not ours\n');
  mkdirSync(join(projectRoot, '.unitbob'), { recursive: true });
  symlinkSync(outside, join(projectRoot, '.unitbob', 'structural'));

  const branch = structuralBranch();
  branch.suite_file = { path: '.unitbob/structural/architecture_map_contracts_spec.rb' };
  const path = writeOutput(projectRoot, { branches: [branch] });

  assert.throws(() => readHostSuiteOutputs(path, readSuiteBuildRequest(projectRoot)), /resolves outside the suite root/);
});

test('names the files the next materialization would delete', () => {
  const projectRoot = tmpProject();
  const steps = join(projectRoot, '.unitbob', 'behavioral', 'step_definitions');
  const support = join(projectRoot, '.unitbob', 'behavioral', 'features', 'support');
  mkdirSync(steps, { recursive: true });
  mkdirSync(support, { recursive: true });
  writeFileSync(join(projectRoot, '.unitbob', 'behavioral', 'features', 'surface_contracts.feature'), 'Feature: x\n');
  writeFileSync(join(steps, 'client_management_steps.rb'), '# listed\n');
  writeFileSync(join(steps, 'billing_steps.rb'), '# forgotten\n');
  // The directory the answer never mentions at all — the case a scan of only the
  // listed directories misses, and the conventional home of a Cucumber helper.
  writeFileSync(join(support, 'env.rb'), '# forgotten too\n');
  // The separately provisioned runner environment is not the answer's to list.
  writeFileSync(join(projectRoot, '.unitbob', 'behavioral', 'Gemfile'), "source 'x'\n");

  const lost = filesLostOnMaterialize(projectRoot, {
    path: '.unitbob/behavioral/features/surface_contracts.feature',
    content: 'Feature: x\n',
    support_files: [{ path: '.unitbob/behavioral/step_definitions/client_management_steps.rb', content: '# listed\n' }],
  }, 'cucumber');

  assert.deepEqual(lost, [
    '.unitbob/behavioral/features/support/env.rb',
    '.unitbob/behavioral/step_definitions/billing_steps.rb',
  ]);
});

// What the run itself leaves behind is not the user's loss. On the bench,
// 2026-09-11, the warning named fourteen `.pyc` files on microblog and the
// World's own SQLite database on soul; the next run makes all of them again.
test('the run\'s own by-products are not named among the files it would delete', () => {
  const projectRoot = tmpProject();
  const root = join(projectRoot, '.unitbob', 'behavioral');
  const steps = join(root, 'step_definitions');
  mkdirSync(join(steps, '__pycache__'), { recursive: true });
  mkdirSync(join(root, '.pytest_cache', 'v'), { recursive: true });
  writeFileSync(join(root, 'features.feature'), 'Feature: x\n');
  writeFileSync(join(steps, 'test_billing.py'), '# forgotten\n');
  writeFileSync(join(steps, '__pycache__', 'test_billing.cpython-311.pyc'), 'x');
  writeFileSync(join(root, '.pytest_cache', 'v', 'nodeids'), '[]');
  writeFileSync(join(root, 'behavioral-app.sqlite'), '');
  writeFileSync(join(root, 'behavioral.db'), '');
  writeFileSync(join(root, 'behavioral.db-shm'), '');
  writeFileSync(join(root, 'behavioral.db-wal'), '');

  const lost = filesLostOnMaterialize(projectRoot, {
    path: '.unitbob/behavioral/features.feature',
    content: 'Feature: x\n',
    support_files: [],
  }, 'pytest-bdd');

  assert.deepEqual(lost, ['.unitbob/behavioral/step_definitions/test_billing.py']);
});

// Spec 49. What `suite-prepare` promises — "nothing from a previous run is left
// where this one will look" — was true of three files out of six. The suite
// files of the last build stayed under `.unitbob/structural/` and
// `.unitbob/behavioral/`, the behavioral runner takes the directory whole, and
// on the bench (2026-09-11) dead scenarios ran under live markers while two
// workers reworded their steps to dodge dead step files. Everything the last
// build wrote moves to `previous/<branch>/` under the same relative path.
function writeUnder(projectRoot: string, relative: string, content = '#\n'): void {
  const path = join(projectRoot, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test('a new build moves the suite files of both branches to previous/<branch>/', () => {
  const projectRoot = tmpProject();
  writeUnder(projectRoot, '.unitbob/structural/st-accounts.test.ts', '// dead\n');
  writeUnder(projectRoot, '.unitbob/structural/_setup.ts', '// last build\'s preparation\n');
  writeUnder(projectRoot, '.unitbob/structural/conftest.py', '# last build\'s harness\n');
  writeUnder(projectRoot, '.unitbob/behavioral/features/cards.feature', 'Feature: cards\n');
  writeUnder(projectRoot, '.unitbob/behavioral/step_definitions/test_cards.py', '# steps\n');

  const moved = movePreviousRunAside(projectRoot, 'pytest-bdd');

  const previous = join(projectRoot, '.unitbob', 'suite-build', 'previous');
  assert.equal(readFileSync(join(previous, 'structural', 'st-accounts.test.ts'), 'utf8'), '// dead\n');
  assert.equal(readFileSync(join(previous, 'structural', '_setup.ts'), 'utf8'), '// last build\'s preparation\n');
  assert.equal(readFileSync(join(previous, 'structural', 'conftest.py'), 'utf8'), '# last build\'s harness\n');
  assert.equal(readFileSync(join(previous, 'behavioral', 'features', 'cards.feature'), 'utf8'), 'Feature: cards\n');
  assert.equal(readFileSync(join(previous, 'behavioral', 'step_definitions', 'test_cards.py'), 'utf8'), '# steps\n');
  for (const gone of [
    '.unitbob/structural/st-accounts.test.ts',
    '.unitbob/structural/_setup.ts',
    '.unitbob/structural/conftest.py',
    '.unitbob/behavioral/features/cards.feature',
    '.unitbob/behavioral/step_definitions/test_cards.py',
  ]) {
    assert.equal(existsSync(join(projectRoot, gone)), false, `${gone} is still where the build will look`);
  }
  assert.deepEqual(moved, { artifacts: [], branches: { structural: 3, behavioral: 2 } });
});

// The connector's and the runner's own files are not the build's, and the next
// `suite-prepare` rewrites or re-provisions every one of them. By-products of
// the run — byte-code caches, the World's SQLite file — are deleted rather than
// carried: nobody wrote them and the next run makes them again.
test('what the connector and the runner own stays; the run\'s by-products are deleted', () => {
  const projectRoot = tmpProject();
  const world = behavioralWorldFor('pytest-bdd')!;
  writeUnder(projectRoot, '.unitbob/structural/unitbob_helper.rb', '# helper\n');
  writeUnder(projectRoot, '.unitbob/structural/rspec.opts', '');
  writeUnder(projectRoot, '.unitbob/structural/pytest_result.xml', '<xml/>');
  writeUnder(projectRoot, '.unitbob/structural/rspec_result.json', '{}');
  writeUnder(projectRoot, '.unitbob/structural/vitest_result.json', '{}');
  writeUnder(projectRoot, '.unitbob/structural/__pycache__/st_accounts.cpython-311.pyc', 'x');
  writeUnder(projectRoot, '.unitbob/structural/test_accounts.py', '# suite\n');
  writeUnder(projectRoot, '.unitbob/behavioral/.venv/bin/python', '');
  writeUnder(projectRoot, world.path, world.content);
  writeUnder(projectRoot, '.unitbob/behavioral/pytest_bdd_report.json', '{}');
  writeUnder(projectRoot, '.unitbob/behavioral/unitbob_pytest_bdd_plugin.py', '#');
  writeUnder(projectRoot, '.unitbob/behavioral/pytest.ini', '[pytest]\n');
  writeUnder(projectRoot, '.unitbob/behavioral/step_definitions/test_cards.py', '# steps\n');
  writeUnder(projectRoot, '.unitbob/behavioral/step_definitions/__pycache__/test_cards.cpython-311.pyc', 'x');
  writeUnder(projectRoot, '.unitbob/behavioral/.pytest_cache/v/nodeids', '[]');
  writeUnder(projectRoot, '.unitbob/behavioral/behavioral.db-wal', '');
  // A link moves as a link — the target is never touched (the rule `filesUnder`
  // follows for the review warning).
  writeUnder(projectRoot, 'lib/shared_steps.py', '# target\n');
  symlinkSync(join(projectRoot, 'lib', 'shared_steps.py'), join(projectRoot, '.unitbob', 'behavioral', 'step_definitions', 'link.py'));

  const moved = movePreviousRunAside(projectRoot, 'pytest-bdd');

  for (const kept of [
    '.unitbob/structural/unitbob_helper.rb',
    '.unitbob/structural/rspec.opts',
    '.unitbob/structural/pytest_result.xml',
    '.unitbob/structural/rspec_result.json',
    '.unitbob/structural/vitest_result.json',
    '.unitbob/behavioral/.venv/bin/python',
    world.path,
    '.unitbob/behavioral/pytest_bdd_report.json',
    '.unitbob/behavioral/unitbob_pytest_bdd_plugin.py',
    '.unitbob/behavioral/pytest.ini',
  ]) {
    assert.equal(existsSync(join(projectRoot, kept)), true, `${kept} should have stayed`);
  }
  const previous = join(projectRoot, '.unitbob', 'suite-build', 'previous');
  assert.equal(existsSync(join(previous, 'structural', 'unitbob_helper.rb')), false);
  assert.equal(existsSync(join(previous, 'behavioral', 'pytest.ini')), false);
  assert.equal(existsSync(join(previous, 'behavioral', world.path.replace('.unitbob/behavioral/', ''))), false);

  for (const byProduct of [
    '.unitbob/structural/__pycache__',
    '.unitbob/behavioral/step_definitions/__pycache__',
    '.unitbob/behavioral/.pytest_cache',
    '.unitbob/behavioral/behavioral.db-wal',
  ]) {
    assert.equal(existsSync(join(projectRoot, byProduct)), false, `${byProduct} should have been deleted`);
    assert.equal(existsSync(join(previous, byProduct.replace('.unitbob/', ''))), false, `${byProduct} should not be in previous/`);
  }

  assert.equal(readFileSync(join(previous, 'structural', 'test_accounts.py'), 'utf8'), '# suite\n');
  assert.equal(readFileSync(join(previous, 'behavioral', 'step_definitions', 'test_cards.py'), 'utf8'), '# steps\n');
  const link = join(previous, 'behavioral', 'step_definitions', 'link.py');
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), join(projectRoot, 'lib', 'shared_steps.py'));
  assert.equal(readFileSync(join(projectRoot, 'lib', 'shared_steps.py'), 'utf8'), '# target\n');
  assert.deepEqual(moved.branches, { structural: 1, behavioral: 2 });
});

// The move and the review warning read one set of "whose file is this". For
// each runner, what the warning stays quiet about is exactly what the move
// leaves in place, and what it would name is exactly what moves.
test('the move keeps what the review warning stays quiet about, for every runner', () => {
  for (const [runner, environment] of [['cucumber', 'Gemfile'], ['cucumber-js', 'package.json'], ['pytest-bdd', '.venv']] as const) {
    const projectRoot = tmpProject();
    const world = behavioralWorldFor(runner)!;
    writeUnder(projectRoot, world.path, world.content);
    writeUnder(projectRoot, `.unitbob/behavioral/${environment}`, '');
    writeUnder(projectRoot, '.unitbob/behavioral/step_definitions/billing_steps.rb', '# forgotten\n');
    const artifact = { path: '.unitbob/behavioral/features/x.feature', content: 'Feature: x\n', support_files: [] };

    assert.deepEqual(filesLostOnMaterialize(projectRoot, artifact, runner), ['.unitbob/behavioral/step_definitions/billing_steps.rb'], runner);
    const moved = movePreviousRunAside(projectRoot, runner);
    assert.equal(moved.branches.behavioral, 1, runner);
    assert.equal(existsSync(join(projectRoot, world.path)), true, `${runner}: the World moved`);
    assert.equal(existsSync(join(projectRoot, '.unitbob', 'behavioral', environment)), true, `${runner}: the environment moved`);
    assert.equal(existsSync(join(projectRoot, '.unitbob', 'behavioral', 'step_definitions', 'billing_steps.rb')), false, runner);
  }
});

// The three review artifacts are bound to the candidate the last build ran, and
// a stale `behavioral_review.json` fails `validate-build` with a message about
// the reviewer. They travel with the plan. And `previous/<branch>/` holds one
// previous build, not an archive: it is replaced whole, the way each artifact is
// replaced by name.
test('review artifacts move beside the plan, and previous/<branch>/ is replaced whole', () => {
  const projectRoot = tmpProject();
  const buildDir = join(projectRoot, '.unitbob', 'suite-build');
  writeFileSync(join(buildDir, 'worker-plan.json'), '{"request_digest":"last"}\n');
  writeFileSync(join(buildDir, 'behavioral_review.json'), '{"candidate_digest":"stale"}\n');
  writeFileSync(join(buildDir, 'candidate-run.json'), '{"candidate_digest":"stale"}\n');
  writeFileSync(join(buildDir, 'review-request.json'), '{"candidate_digest":"stale"}\n');
  writeUnder(projectRoot, '.unitbob/suite-build/previous/structural/from_two_builds_ago.py', '# older\n');
  writeUnder(projectRoot, '.unitbob/structural/test_accounts.py', '# last\n');

  const moved = movePreviousRunAside(projectRoot, 'pytest-bdd');

  const previous = join(buildDir, 'previous');
  assert.deepEqual(moved.artifacts, ['worker-plan.json', 'behavioral_review.json', 'candidate-run.json', 'review-request.json']);
  for (const name of moved.artifacts) {
    assert.equal(existsSync(join(buildDir, name)), false, `${name} is still where the build will look`);
    assert.equal(existsSync(join(previous, name)), true, `${name} is not in previous/`);
  }
  assert.equal(existsSync(join(previous, 'structural', 'from_two_builds_ago.py')), false);
  assert.equal(readFileSync(join(previous, 'structural', 'test_accounts.py'), 'utf8'), '# last\n');
});

test('rejects the legacy spec_rb shape per branch', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const path = writeOutput(projectRoot, { branches: [{ suite_kind: 'structural', spec_rb: "require 'x'\n" }] });

  assert.throws(() => readHostSuiteOutputs(path, readSuiteBuildRequest(projectRoot)), /legacy spec_rb shape/);
});

test('rejects unsafe file paths under each branch root', () => {
  const projectRoot = tmpProject();
  writeTask(projectRoot);
  const request = readSuiteBuildRequest(projectRoot);

  for (const unsafe of ['/etc/passwd', 'spec/pwned_spec.rb', '.unitbob/structural/../../pwned.rb']) {
    const branch = structuralBranch();
    (branch.suite_file as Record<string, unknown>).path = unsafe;
    const path = writeOutput(projectRoot, { branches: [branch] });
    assert.throws(() => readHostSuiteOutputs(path, request), /relative path under/, unsafe);
  }
});

test('recipeNameFor maps each kind to its generation recipe', () => {
  const structural: SuitePacket = { suite_kind: 'structural', source_digest: 'm', path_root: '.unitbob/structural/', assignment: {} };
  const behavioral: SuitePacket = { suite_kind: 'behavioral', source_digest: 's', path_root: '.unitbob/behavioral/', assignment: {} };
  assert.equal(recipeNameFor(structural), 'generate');
  assert.equal(recipeNameFor(behavioral), 'generate_behavioral');
});

test('readSuiteBuildRequest errors with guidance when the task is missing', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-no-task-'));
  assert.throws(() => readSuiteBuildRequest(projectRoot), /run `npx unitbob suite-prepare` first/);
});

// The same fixture and the same value as `spec/models/suite_version_spec.rb` on
// the server. Two serializers that sort object keys and do nothing else — no
// path ordering, no line-ending normalization — which is exactly why they agree.
// A normalization added on one side alone breaks every behavioral upload, and
// this pair of pinned values is the only thing that would catch it.
test('shares a golden behavioral review candidate digest with the server', () => {
  assert.equal(
    suiteCandidateDigest(behavioralBranch()),
    '37de05cb0fb0f2ca404814a353b8d45e2f5610a60efdc5a902f575c8f5add81c',
  );
});

// Spec 43, §4. The digest names what the reviewer read. Editing metadata — the
// very fix the server had demanded, on a run where the reviewer was right — used
// to declare the review stale and cost a re-binding plus a second reviewer pass
// while the suite files stood untouched.
test('a metadata edit leaves the candidate digest where it was', () => {
  const before = suiteCandidateDigest(behavioralBranch());
  const edited = behavioralBranch();
  edited.test_metadata = {
    capabilities: [{ capability_id: 'billing', deferred_surfaces: ['PUT /orders/:id'] }],
  };

  assert.equal(suiteCandidateDigest(edited), before);
});

test('a suite file edit moves it', () => {
  const edited = behavioralBranch();
  (edited.suite_file as Record<string, unknown>).content = 'Feature: something else\n';

  assert.notEqual(suiteCandidateDigest(edited), suiteCandidateDigest(behavioralBranch()));
});

