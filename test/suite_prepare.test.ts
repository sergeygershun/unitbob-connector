import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suitePrepare } from '../src/verbs/suitePrepare.ts';
import { UNITBOB_HELPER_RB } from '../src/files/guardrails.ts';
import { readSuiteBuildRequest } from '../src/files/suiteBuild.ts';
import type { Config } from '../src/config.ts';
import type { SuitePacket } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-suite-prepare-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

const okPrecheck = () => ({ ok: true });
const okRunner = async () => ({ status: 'provisioned' as const });

// A branch with no complete runner envelope is not built at all, so tests about
// recipes, defect context, and next-step wording stub one in. The selection
// itself is exercised further down, against real packets and a real project.
const okEnvelope = () => ({ runner: 'rspec' });

// A project whose stack the connector can actually detect. The behavioral runner
// now follows the structural one, so a directory with no stack markers has no
// BDD runner either — which is right, and which `anyStackPrecheck` would have
// stopped long before this point in production.
function railsProject(): string {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, 'Gemfile'), "gem 'rails'\ngem 'rspec-rails'\n");
  return projectRoot;
}

function packets(): SuitePacket[] {
  return [
    {
      suite_kind: 'structural',
      source_digest: 'map-d',
      path_root: '.unitbob/structural/',
      assignment: { blocks: [{ block_id: 'billing', interfaces: [] }] },
    },
    {
      suite_kind: 'behavioral',
      source_digest: 'surface-d',
      path_root: '.unitbob/behavioral/',
      assignment: { capabilities: [{ capability_id: 'checkout' }] },
    },
  ];
}

test('suite-prepare fetches both peer assignments and each branch recipe, then writes request.json', async () => {
  const projectRoot = tmpProject();
  const calls: string[] = [];

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => { calls.push(`recipe:${name}`); return { name, version: `${name}-v1`, text: `${name} recipe` }; },
    getSuitePacketsBatch: async () => { calls.push('packets'); return packets(); },
    stdout: { write: () => true },
  });

  assert.deepEqual(calls.sort(), ['packets', 'recipe:generate', 'recipe:generate_behavioral']);
  const request = readSuiteBuildRequest(projectRoot);
  assert.deepEqual(request.branches.map((branch) => branch.suite_kind), ['structural', 'behavioral']);

  const structural = request.branches.find((branch) => branch.suite_kind === 'structural')!;
  assert.equal(structural.source_digest, 'map-d');
  assert.equal(structural.path_root, '.unitbob/structural/');
  assert.equal(structural.recipe.name, 'generate');

  const behavioral = request.branches.find((branch) => branch.suite_kind === 'behavioral')!;
  assert.equal(behavioral.source_digest, 'surface-d');
  assert.equal(behavioral.recipe.name, 'generate_behavioral');
});

test('suite-prepare records a user-supplied known defect outside host-authored metadata', async () => {
  const projectRoot = tmpProject();

  await suitePrepare(config(projectRoot), [
    '--known-defect=Report#method_name calls the missing calculation_type method',
    '--fixed-revision=fix-report-method-name',
  ], {
    precheck: okPrecheck,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: () => true },
  });

  assert.deepEqual(readSuiteBuildRequest(projectRoot).known_defect_context, {
    status: 'supplied',
    defect: 'Report#method_name calls the missing calculation_type method',
    fixed_revision: 'fix-report-method-name',
  });
});

test('suite-prepare refuses to silently assume that no known defect was supplied', async () => {
  const projectRoot = tmpProject();
  let fetched = false;

  await assert.rejects(
    () => suitePrepare(config(projectRoot), [], {
      precheck: okPrecheck,
        ensureRunner: okRunner,
      getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
      getSuitePacketsBatch: async () => { fetched = true; return packets(); },
      stdout: { write: () => true },
    }),
    /choose exactly one of --known-defect or --no-known-defect/i,
  );
  assert.equal(fetched, false);
});

test('suite-prepare prints a next-step naming both kinds, the output_path, and separate review', async () => {
  const projectRoot = tmpProject();
  let output = '';

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  });

  const outputPath = join(projectRoot, '.unitbob', 'suite-build', 'suite_output.json');
  assert.match(output, /build both peer suites/);
  assert.match(output, /structural and behavioral/);
  assert.ok(output.includes(outputPath), 'names the output_path');
  assert.match(output, /`unitbob suite-review-prepare`/);
  assert.doesNotMatch(output, /then run `unitbob put-suite-build`/i);
  assert.match(output, /harness.*application failures.*red/i);
  assert.doesNotMatch(output, /run each locally to green/i);
});

test('suite-prepare materializes the boot helper right after the precheck', async () => {
  const projectRoot = tmpProject();

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: () => true },
  });

  const helperPath = join(projectRoot, '.unitbob', 'structural', 'unitbob_helper.rb');
  assert.equal(readFileSync(helperPath, 'utf8'), UNITBOB_HELPER_RB);
});

test('suite-prepare stops on an unsupported runtime and writes nothing', async () => {
  const projectRoot = tmpProject();
  let fetched = false;

  await assert.rejects(
    () =>
      suitePrepare(config(projectRoot), ['--no-known-defect'], {
        precheck: () => ({ ok: false, message: 'This project does not look like Rails + RSpec.' }),
        getRecipe: async () => { fetched = true; return { name: 'generate', version: 'v1', text: 'recipe' }; },
        getSuitePacketsBatch: async () => packets(),
        stdout: { write: () => true },
      }),
    /Rails \+ RSpec/,
  );

  assert.equal(fetched, false);
  assert.throws(() => readSuiteBuildRequest(projectRoot), /run `npx unitbob suite-prepare` first/);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'structural', 'unitbob_helper.rb')), false);
});

test('suite-prepare surfaces a no-current-map error and writes nothing', async () => {
  const projectRoot = tmpProject();

  await assert.rejects(
    () =>
      suitePrepare(config(projectRoot), ['--no-known-defect'], {
        precheck: okPrecheck,
            getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
        getSuitePacketsBatch: async () => {
          throw new Error('GET /repos/3/suite_packets failed: 409 — rebuild the Unitbob map first.');
        },
        stdout: { write: () => true },
      }),
    /rebuild the Unitbob map/,
  );

  assert.throws(() => readSuiteBuildRequest(projectRoot), /run `npx unitbob suite-prepare` first/);
});

test('a fixable behavioral runner blocker does not abort the build or block the structural peer', async () => {
  const projectRoot = railsProject();
  let output = '';

  // Spec 32-1: a `fixable` provision outcome is infrastructure the vibecoder clears with one
  // command — never a build_error dead-end, never a red lamp, and it must not take the structural
  // suite down with it.
  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    ensureRunner: async () => ({
      status: 'fixable',
      message: 'Bundler missing',
      checklist: ['Install bundler (`gem install bundler`)'],
    }),
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  });

  // Structural still builds; the unprovisioned behavioral branch is dropped from this run.
  const request = readSuiteBuildRequest(projectRoot);
  assert.deepEqual(request.branches.map((branch) => branch.suite_kind), ['structural']);

  // The vibecoder gets a fixable checklist, not a failure.
  assert.match(output, /Behavioral suite skipped this run/);
  assert.match(output, /Bundler missing/);
  assert.match(output, /Install bundler/);
  assert.doesNotMatch(output, /build_error|provision incomplete/i);
  assert.match(output, /`unitbob put-suite-build`/);
  assert.doesNotMatch(output, /`unitbob suite-review-prepare`/);
});

test('suite-prepare invokes the runner provision for the behavioral branch', async () => {
  const projectRoot = railsProject();
  const provisioned: string[] = [];

  // Regression guard for the stub-default bug: provisioning must actually run for the behavioral
  // peer during preflight. (The production default is the real `ensureRunner`; `noUnusedLocals`
  // fails the build if that import is ever left unwired again.)
  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    ensureRunner: async (_root, runner) => { provisioned.push(runner); return { status: 'provisioned' }; },
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: () => true },
  });

  assert.deepEqual(provisioned, ['cucumber']);
});

test('a provisioned behavioral runner keeps both peer suites in the request', async () => {
  const projectRoot = railsProject();

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    ensureRunner: async () => ({ status: 'provisioned' }),
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: () => true },
  });

  const request = readSuiteBuildRequest(projectRoot);
  assert.deepEqual(request.branches.map((branch) => branch.suite_kind), ['structural', 'behavioral']);
});

// The host used to compose `runner_manifest` from a recipe that showed only its
// shape, and a wrong field was rejected at upload — after the suite had been
// written, run, and reviewed. The server now ships the envelopes it accepts and
// the connector picks the one naming the strategy it detected and will run, so
// the host copies instead of composing.
function packetsWithManifests(): SuitePacket[] {
  const [structural, behavioral] = packets();
  return [
    {
      ...structural,
      runner_manifests: [
        { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' },
        { language: 'javascript', framework: 'vitest', result_format: 'vitest_json', runner: 'vitest' },
      ],
    },
    {
      ...behavioral,
      runner_manifests: [
        { language: 'ruby', framework: 'cucumber', result_format: 'cucumber_messages',
          runner: 'cucumber', package_manager: 'bundler' },
      ],
    },
  ];
}

// The sidecar the connector provisions, with a resolved version in it. The
// behavioral envelope is incomplete without one, so a test that wants that
// branch built has to stand this up.
function withInstalledCucumber(projectRoot: string): string {
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.unitbob', 'behavioral', 'Gemfile.lock'),
    'GEM\n  specs:\n    cucumber (9.2.1)\n    rails (7.1.0)\n',
  );
  return projectRoot;
}

async function prepareWith(
  projectRoot: string,
  packetList: SuitePacket[],
  onOutput: (chunk: string) => void = () => {},
): Promise<void> {
  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    ensureRunner: okRunner,
    getRecipe: async (name) => ({ name, version: `${name}-v1`, text: 't' }),
    getSuitePacketsBatch: async () => packetList,
    stdout: { write: (chunk: string) => { onOutput(chunk); return true; } },
  });
}

test('suite-prepare hands the host the runner envelope its own stack selects', async () => {
  const projectRoot = withInstalledCucumber(railsProject());

  await prepareWith(projectRoot, packetsWithManifests());

  const request = readSuiteBuildRequest(projectRoot);
  const structural = request.branches.find((branch) => branch.suite_kind === 'structural')!;
  const behavioral = request.branches.find((branch) => branch.suite_kind === 'behavioral')!;

  assert.deepEqual(structural.runner_manifest, {
    language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec',
  });
  assert.equal((behavioral.runner_manifest as Record<string, unknown>).runner, 'cucumber');
});

// Nothing invented, and nothing half-filled: a branch this machine cannot
// describe is not handed to the host at all. Writing it anyway would only move
// the server's rejection to the end of the run, after the suite was written,
// run, and reviewed. Its peer is unaffected.
test('a branch whose runner none of the offered envelopes name is left out, and its peer still builds', async () => {
  const projectRoot = withInstalledCucumber(railsProject());
  const [structural, behavioral] = packetsWithManifests();
  let output = '';

  await prepareWith(projectRoot, [
    { ...structural, runner_manifests: [{ language: 'python', framework: 'pytest', result_format: 'junit_xml', runner: 'pytest' }] },
    behavioral,
  ], (chunk) => { output += chunk; });

  const request = readSuiteBuildRequest(projectRoot);
  assert.deepEqual(request.branches.map((branch) => branch.suite_kind), ['behavioral']);
  assert.match(output, /structural: this project matches none of the runners the server offered/);
});

// An older server sends no envelopes at all. There is nothing to select and
// nothing for the host to copy, so the command stops with the one fix that
// helps — never a request the host would fill in by guessing.
test('suite-prepare builds nothing and names the cause when the server offered no envelopes', async () => {
  const projectRoot = withInstalledCucumber(railsProject());

  await assert.rejects(
    prepareWith(projectRoot, packets()),
    /sent no runner combinations .* older than this connector/s,
  );
  assert.throws(() => readSuiteBuildRequest(projectRoot), /run `npx unitbob suite-prepare` first/);
});

// Read after provisioning, from the sidecar the connector just installed: only
// this machine knows which version is actually there.
test('suite-prepare stamps the behavioral envelope with the installed runner version', async () => {
  const projectRoot = withInstalledCucumber(railsProject());

  await prepareWith(projectRoot, packetsWithManifests());

  const request = readSuiteBuildRequest(projectRoot);
  const behavioral = request.branches.find((branch) => branch.suite_kind === 'behavioral')!;
  assert.equal((behavioral.runner_manifest as Record<string, unknown>).runner_version, '9.2.1');
});

// A constraint is not a version. `~> 9.0` in the Gemfile says what may install,
// not what did, and the server requires the resolved one. With nothing to read,
// the envelope would be incomplete — so the branch is left out instead, and the
// structural peer builds without it.
test('the behavioral branch is left out when the sidecar records no installed version', async () => {
  const projectRoot = railsProject();
  let output = '';

  await prepareWith(projectRoot, packetsWithManifests(), (chunk) => { output += chunk; });

  const request = readSuiteBuildRequest(projectRoot);
  assert.deepEqual(request.branches.map((branch) => branch.suite_kind), ['structural']);
  assert.match(output, /behavioral: the version of "cucumber" installed under \.unitbob\/behavioral\/ could not be read/);
});

// One project, one language. A second probe used to answer on `package.json`
// alone, so a Rails app with any front-end build got JavaScript step definitions
// that cannot boot Rails — a branch dead before it was written.
test('the behavioral runner follows the structural stack, not a package.json next to it', async () => {
  const projectRoot = withInstalledCucumber(railsProject());
  writeFileSync(join(projectRoot, 'package.json'), '{ "name": "app", "devDependencies": {} }\n');
  const provisioned: string[] = [];

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    ensureRunner: async (_root, runner) => { provisioned.push(runner); return { status: 'provisioned' }; },
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packetsWithManifests(),
    stdout: { write: () => true },
  });

  assert.deepEqual(provisioned, ['cucumber']);
  const behavioral = readSuiteBuildRequest(projectRoot).branches
    .find((branch) => branch.suite_kind === 'behavioral')!;
  assert.equal((behavioral.runner_manifest as Record<string, unknown>).runner, 'cucumber');
});

