import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suitePrepare as runSuitePrepare } from '../src/verbs/suitePrepare.ts';
import { UNITBOB_HELPER_RB } from '../src/files/guardrails.ts';
import { BEHAVIORAL_WORLD, BEHAVIORAL_WORLD_PATH, behavioralWorldFor } from '../src/files/behavioral.ts';
import { readSuiteBuildRequest } from '../src/files/suiteBuild.ts';
import type { Config } from '../src/config.ts';
import type { SuitePacket } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-suite-prepare-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

// Mirrors the real gate, which now hands back the stack it identified so
// suite-prepare need not detect it a second time (on Python that meant shelling
// out to pytest twice).
const okPrecheck = () => ({ ok: true, runner: 'rspec' });
const okRunner = async () => ({ status: 'provisioned' as const });
const okWorld = async () => ({ status: 'ok' as const });

type SuitePrepareDeps = NonNullable<Parameters<typeof runSuitePrepare>[2]>;
// Provisioning the structural runner and confirming it are stubbed for the same
// reason the boot check is: these tests are about what suite-prepare does once
// the stack is runnable. `provision.test.ts` and `precheck.test.ts` own the two
// steps themselves, and the tests at the end of this file own what suite-prepare
// does when either of them says no.
const okConfirm = () => ({ ok: true });
const suitePrepare = (cfg: Config, args: string[], deps?: Partial<SuitePrepareDeps>) =>
  runSuitePrepare(cfg, args, {
    worldProbe: okWorld,
    ensureStructuralRunner: okRunner,
    confirmRunner: okConfirm,
    ...deps,
  });

// Spec 32-6: suite-prepare now loads the file the suite starts from before it
// fetches or writes anything. These tests are about everything that happens
// afterwards, so they stub the answer. `bootcheck.test.ts` owns the check
// itself, and the tests at the end of this file own what suite-prepare does
// with a `broken` one.
const okBoot = async () => ({ status: 'ok' as const });

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
    bootCheck: okBoot,
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

// Spec 44, §3.2. The one thing a step file must get right to exist at all — its
// name — was known only inside `src/runner/bdd.ts`, and the recipe's retelling of
// it was wrong for pytest. It now travels on the branch that will be written
// against that runner, and is printed where the coordinator is already reading.
test('the behavioral branch carries the runner\'s own rule for which step files it loads', async () => {
  const projectRoot = tmpProject();
  const output: string[] = [];

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: okBoot,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => {
      const [structural, behavioral] = packets();
      return [structural, { ...behavioral, runner: 'pytest-bdd' } as SuitePacket];
    },
    stdout: { write: (chunk) => { output.push(chunk); return true; } },
  });

  const request = readSuiteBuildRequest(projectRoot);
  const behavioral = request.branches.find((branch) => branch.suite_kind === 'behavioral')!;
  assert.equal(behavioral.step_loading?.step_files, 'test_*.py');
  assert.ok((behavioral.step_loading?.requirements.length ?? 0) > 0);
  // The structural peer loads nothing through a BDD strategy and states no rule
  // — an empty one would read as "any name will do".
  assert.equal(request.branches.find((branch) => branch.suite_kind === 'structural')!.step_loading, undefined);

  const text = output.join('');
  assert.match(text, /Behavioral steps run under "pytest-bdd"/);
  assert.match(text, /`test_\*\.py`/);
  assert.match(text, /`step_loading`/);
});

// The Edge Case §43 names: a runner whose loading rule this connector does not
// hold. It says what it does not know rather than printing nothing — silence
// beside a runner name reads as "any name will do", which is the exact belief
// that put a pattern pytest does not collect into the recipe.
test('a behavioral runner with no strategy is admitted to, not passed over in silence', async () => {
  const projectRoot = tmpProject();
  const output: string[] = [];

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: okBoot,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => {
      const [structural, behavioral] = packets();
      return [structural, { ...behavioral, runner: 'behave' } as SuitePacket];
    },
    stdout: { write: (chunk) => { output.push(chunk); return true; } },
  });

  const behavioral = readSuiteBuildRequest(projectRoot).branches
    .find((branch) => branch.suite_kind === 'behavioral')!;
  assert.equal(behavioral.step_loading, undefined, 'no rule is invented for a runner we do not run');
  assert.match(output.join(''), /does not know how that runner finds its step files/);
});

test('suite-prepare records a user-supplied known defect outside host-authored metadata', async () => {
  const projectRoot = tmpProject();

  await suitePrepare(config(projectRoot), [
    '--known-defect=Report#method_name calls the missing calculation_type method',
    '--fixed-revision=fix-report-method-name',
  ], {
    precheck: okPrecheck,
    bootCheck: okBoot,
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
      bootCheck: okBoot,
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
    bootCheck: okBoot,
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

async function prepareIn(projectRoot: string): Promise<void> {
  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: okBoot,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: () => true },
  });
}

test('suite-prepare materializes the boot helper right after the precheck, in a Ruby project', async () => {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, 'Gemfile'), "gem 'rails'\ngem 'rspec-rails'\n");

  await prepareIn(projectRoot);

  const helperPath = join(projectRoot, '.unitbob', 'structural', 'unitbob_helper.rb');
  assert.equal(readFileSync(helperPath, 'utf8'), UNITBOB_HELPER_RB);
});

// Spec 43, §5.1. This step was unconditional, so a Flask app and a NestJS app
// each came away with a Ruby boot helper and an `rspec.opts` they cannot run and
// never asked for — the product leaving another stack's litter in someone's
// repository.
for (const [stack, marker, contents] of [
  ['Python', 'requirements.txt', 'flask\n'],
  ['JavaScript', 'package.json', '{}'],
] as const) {
  test(`suite-prepare writes no Ruby file into a ${stack} project`, async () => {
    const projectRoot = tmpProject();
    writeFileSync(join(projectRoot, marker), contents);

    await prepareIn(projectRoot);

    const structural = join(projectRoot, '.unitbob', 'structural');
    assert.equal(existsSync(join(structural, 'unitbob_helper.rb')), false);
    assert.equal(existsSync(join(structural, 'rspec.opts')), false);
  });
}

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
        bootCheck: okBoot,
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
    bootCheck: okBoot,
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
    bootCheck: okBoot,
    ensureRunner: async (_root, runner) => { provisioned.push(runner); return { status: 'provisioned' }; },
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: () => true },
  });

  assert.deepEqual(provisioned, ['cucumber']);
});

test('suite-prepare materializes and probes the connector-owned World after provisioning', async () => {
  const projectRoot = railsProject();
  const events: string[] = [];

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: okBoot,
    ensureRunner: async () => { events.push('provision'); return { status: 'provisioned' }; },
    worldProbe: async (root) => {
      events.push('probe');
      assert.equal(readFileSync(join(root, BEHAVIORAL_WORLD_PATH), 'utf8'), BEHAVIORAL_WORLD);
      return { status: 'ok' };
    },
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: () => true },
  });

  assert.deepEqual(events, ['provision', 'probe']);
});

test('a failed World probe is fixable and excludes only the behavioral branch before fan-out', async () => {
  const projectRoot = railsProject();
  let output = '';

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: okBoot,
    ensureRunner: okRunner,
    worldProbe: async () => ({ status: 'fixable', message: 'assertion counter did not advance' }),
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: (chunk: string) => { output += chunk; return true; } },
  });

  assert.deepEqual(readSuiteBuildRequest(projectRoot).branches.map((branch) => branch.suite_kind), ['structural']);
  assert.match(output, /assertion counter did not advance/);
  assert.match(output, /fixable/i);
  assert.doesNotMatch(output, /BDD runner is not installed yet/);
});

test('a provisioned behavioral runner keeps both peer suites in the request', async () => {
  const projectRoot = railsProject();

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: okBoot,
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
    bootCheck: okBoot,
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
    bootCheck: okBoot,
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

// --- Spec 32-6 Phase 1: the boot check gates the request -----------------

// The decisive property. A request on disk is a job the host picks up, so a
// suite that cannot start must leave nothing behind — otherwise the run
// continues and every test written dies before its first assertion.
test('a suite that cannot start writes no request at all', async () => {
  const projectRoot = railsProject();
  let output = '';

  await assert.rejects(
    suitePrepare(config(projectRoot), ['--no-known-defect'], {
      precheck: okPrecheck,
      bootCheck: async () => ({
        status: 'broken',
        cause: 'defect_in_code',
        message: "undefined method `before_validation' for main:Object",
        detail: 'app/models/report.rb:1',
      }),
      ensureRunner: okRunner,
      runnerEnvelope: okEnvelope,
      getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
      getSuitePacketsBatch: async () => packets(),
      stdout: { write: (chunk) => { output += chunk; return true; } },
    }),
    (err: Error) => {
      // The runner's own words, and framed as something found rather than
      // something refused.
      assert.match(err.message, /Found a defect that stops your test suite from starting/);
      assert.match(err.message, /undefined method `before_validation'/);
      assert.match(err.message, /No suite was written and nothing was uploaded/);
      return true;
    },
  );

  assert.equal(existsSync(join(projectRoot, '.unitbob', 'suite-build', 'request.json')), false);
  assert.equal(output, '', 'nothing was reported as progress before the stop');
});

// Same stop, different words: an un-run `bundle install` is not the user's bug,
// and we say which install to run rather than installing it ourselves.
test('an environment that is not ready stops with the install named, not performed', async () => {
  await assert.rejects(
    suitePrepare(config(railsProject()), ['--no-known-defect'], {
      precheck: okPrecheck,
      bootCheck: async () => ({
        status: 'broken',
        cause: 'environment_not_ready',
        message: 'Bundler::GemNotFound: Could not find rake-13.0.6',
        detail: 'bundler: failed to load command: rspec',
      }),
      ensureRunner: okRunner,
      runnerEnvelope: okEnvelope,
      getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
      getSuitePacketsBatch: async () => packets(),
      stdout: { write: () => true },
    }),
    (err: Error) => {
      assert.match(err.message, /environment is not ready/);
      // The runner and the project's declared dependencies are installed under
      // `.unitbob/runners/`, so the wording no longer claims we install nothing.
      // What is left for the reader is whatever their declaration does not cover.
      assert.match(err.message, /installs the runner.*into `\.unitbob\/runners\/`/);
      assert.match(err.message, /never writes to your project/);
      assert.match(err.message, /bundle install/);
      return true;
    },
  );
});

// Not checked is not broken. Conflating them would turn away projects that are
// entirely fine — a Python project whose tests do not exist yet, a stack with
// no runner installed, a load that ran long.
test('a check that could not be made does not block generation', async () => {
  const projectRoot = railsProject();
  let output = '';

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: async () => ({ status: 'not_checked', reason: 'nothing_to_load' }),
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: (chunk) => { output += chunk; return true; } },
  });

  assert.equal(readSuiteBuildRequest(projectRoot).branches.length, 2);
  assert.match(output, /Did not check whether the suite can start/);
  assert.match(output, /Generation continues/);
});

// A check nobody hears about is a check nobody trusts, so the quiet answer is
// reported too — together with what this stack's answer is actually worth.
// Promising all three stacks the same guarantee is the claim 32-5 had to delete.
test('the finding is printed even when the suite starts, with the stack caveat', async () => {
  const projectRoot = railsProject();
  let output = '';

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: okBoot,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: (chunk) => { output += chunk; return true; } },
  });

  assert.match(output, /Checked that the suite can start: it does\./);
  assert.match(output, /Full signal on this stack/);
});

// Found on the fifth implementation review, 2026-08-03. The caveat rode along
// with `ok` and with `not_checked` and fell off `broken` — the one answer that
// stops the run. On pytest and vitest the check collects the project's *whole*
// test tree, so a failure can belong to a test of the project's own that the
// Unitbob suite would never have imported. Withholding that where generation
// stops sends the vibecoder to fix a file this product was never going to touch.
test('a stop on a wide-signal stack carries the caveat that made it wide', async () => {
  await assert.rejects(
    suitePrepare(config(railsProject()), ['--no-known-defect'], {
      precheck: () => ({ ok: true, runner: 'pytest' }),
      bootCheck: async () => ({
        status: 'broken',
        cause: 'defect_in_code',
        message: "ModuleNotFoundError: No module named 'legacy'",
        detail: 'tests/test_legacy.py:3',
      }),
      ensureRunner: okRunner,
      runnerEnvelope: okEnvelope,
      getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
      getSuitePacketsBatch: async () => packets(),
      stdout: { write: () => true },
    }),
    (err: Error) => {
      assert.match(err.message, /Found a defect that stops your test suite from starting/);
      assert.match(err.message, /Partial signal on this stack/);
      assert.match(err.message, /one of the project's own tests/);
      // Both halves of the caveat, or the stop claims more than was asked: this
      // refuses the behavioural branch too, on the word of a check that never
      // looked at it.
      assert.match(err.message, /says nothing about the product-behaviour branch/i);
      return true;
    },
  );
});

// Recorded on the fifth implementation review, 2026-08-03. One branch was
// asked, two branches are about to be built. "The suite can start" read as a
// statement about both.
test('a clean start claims only the branch that was actually asked', async () => {
  const projectRoot = railsProject();
  let output = '';

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: okBoot,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: (chunk) => { output += chunk; return true; } },
  });

  assert.match(output, /says nothing about the product-behaviour branch/i);
});

// Spec 34-6, criterion 2.3. `budget` is gone from the request: after the three
// ceilings it named were removed there was nothing left in it, and the two
// functions it also held were already dead. Its absence is asserted, not just
// unasserted, because the field silently growing back is how a removed ceiling
// comes back as a number nobody decided on.
test('suite-prepare writes no run budget in the request', async () => {
  const projectRoot = tmpProject();

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: okBoot,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: () => true },
  });

  const raw = JSON.parse(readFileSync(join(projectRoot, '.unitbob', 'suite-build', 'request.json'), 'utf8'));
  assert.equal(raw.budget, undefined);
  assert.equal(readSuiteBuildRequest(projectRoot).branches.length > 0, true);
});

// Spec 34-6, criterion 3, edge case. A new request is a new build, and a build
// that has not run once cannot be stuck: a failure set remembered from the build
// before would stop a branch on its very first run.
test('suite-prepare forgets the failures the previous build ended on', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.unitbob', 'suite-build', 'run-state.json'),
    JSON.stringify({ branches: { structural: 'a-hash-from-the-last-build' } }),
  );

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: okBoot,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: () => true },
  });

  assert.equal(existsSync(join(projectRoot, '.unitbob', 'suite-build', 'run-state.json')), false);
});

// The runner is installed before anything is fetched or written, so a vibecoder
// who has never installed one is not turned away. These two tests pin the ends
// of that: nothing is generated on a machine where it could not be installed,
// and what could not be installed for them is said plainly when it can.
test('suite-prepare stops when the structural runner cannot be installed, and writes nothing', async () => {
  const projectRoot = tmpProject();
  let fetched = false;

  await assert.rejects(
    () =>
      suitePrepare(config(projectRoot), ['--no-known-defect'], {
        precheck: okPrecheck,
        ensureStructuralRunner: async () => ({
          status: 'fixable' as const,
          message: 'Failed to create a virtual environment under .unitbob/runners/.venv.',
          checklist: ['Install python3-venv or uv.'],
        }),
        getRecipe: async () => { fetched = true; return { name: 'generate', version: 'v1', text: 'recipe' }; },
        getSuitePacketsBatch: async () => { fetched = true; return packets(); },
        stdout: { write: () => true },
      }),
    // The cause, the consequence, and the one command that clears it.
    /virtual environment.*Install python3-venv or uv.*Nothing was written/s,
  );

  assert.equal(fetched, false);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'suite-build', 'request.json')), false);
});

test('suite-prepare passes on what provisioning could not do for them', async () => {
  const projectRoot = tmpProject();
  let printed = '';

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    ensureStructuralRunner: async () => ({
      status: 'provisioned' as const,
      checklist: ['Run `npm install` in the project before generating.'],
    }),
    bootCheck: okBoot,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: `${name}-v1`, text: `${name} recipe` }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: (chunk) => (printed += chunk) },
  });

  assert.match(printed, /Run `npm install` in the project before generating\./);
  // A note, not a refusal: the request is still written and the build goes on.
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'suite-build', 'request.json')), true);
});

// Spec 35-1, criterion 2. A worker decides what a step may assume before it
// writes one, so the fact has to arrive here — not as a surprise in the middle
// of a run that quietly went out to the network.
test('the behavioral branch is told what Cucumber does not load before a step is written', async () => {
  const projectRoot = railsProject();
  const output: string[] = [];

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: okBoot,
    ensureRunner: okRunner,
    runnerEnvelope: () => ({ runner: 'cucumber' }),
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: (chunk) => { output.push(chunk); return true; } },
  });

  const text = output.join('');
  assert.match(text, /Cucumber loads neither `spec\/rails_helper\.rb` nor `spec\/support\/\*\*`/);
  assert.match(text, /outgoing HTTP is blocked/);
});

// The same run on the other two stacks. Every branch is told, and each is told
// its own runner's facts — a Ruby sentence printed over a Python branch would be
// exactly as untrue as the silence it replaced.
for (const runner of ['pytest-bdd', 'cucumber-js'] as const) {
  test(`the ${runner} branch is told its own harness facts, and no Ruby ones`, async () => {
    const projectRoot = tmpProject();
    const output: string[] = [];

    await suitePrepare(config(projectRoot), ['--no-known-defect'], {
      precheck: okPrecheck,
      bootCheck: okBoot,
      ensureRunner: okRunner,
      runnerEnvelope: () => ({ runner }),
      getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
      getSuitePacketsBatch: async () => {
        const [structural, behavioral] = packets();
        return [structural, { ...behavioral, runner } as SuitePacket];
      },
      stdout: { write: (chunk) => { output.push(chunk); return true; } },
    });

    const text = output.join('');
    assert.match(text, /leave this machine is refused/);
    assert.doesNotMatch(text, /rails_helper/);

    // And the harness the notice describes is actually on disk by now, restored
    // for this runner the same way the Ruby World always was.
    const world = behavioralWorldFor(runner)!;
    assert.equal(readFileSync(join(projectRoot, world.path), 'utf8'), world.content);
  });
}

// Spec 36, criterion 7 and task 3.2. The check for "can work happen where this
// project's dependencies live" runs before the first write and before the first
// call to the server. After a suite has been generated and run, the evidence has
// already gone: a container that is not sharing the folder takes the report with
// it when it stops.
test('an unusable execution place stops suite-prepare before anything is written or fetched', async () => {
  const projectRoot = railsProject();
  writeFileSync(
    join(projectRoot, '.unitbob.json'),
    JSON.stringify({ server: 'https://host', repo_id: 3, token: 't', exec: { docker: { container: 'nope' } } }),
  );
  let fetched = false;

  await assert.rejects(
    () => suitePrepare(config(projectRoot), ['--no-known-defect'], {
      precheck: okPrecheck,
      bootCheck: okBoot,
      ensureRunner: okRunner,
      getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
      getSuitePacketsBatch: async () => { fetched = true; return packets(); },
      stdout: { write: () => true },
    }),
    /container `nope`/,
  );

  assert.equal(fetched, false);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'suite-build')), false);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'structural')), false);
});

// Spec 37-1. The packets are built right after the request, from the same
// assignment, before any worker exists. `suite_packets.test.ts` owns the
// resolving itself; these two own the wiring and what the coordinator is told.
test('suite-prepare resolves the assignment entrypoints and writes their packets', async () => {
  const projectRoot = railsProject();
  writeFileSync(join(projectRoot, 'app_models.rb'), "class User\n  def get_token; end\nend\n");
  mkdirSync(join(projectRoot, 'graphify-out'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'graphify-out', 'graph.json'),
    JSON.stringify({ nodes: [
      { id: 'n0', label: 'User', source_file: 'app_models.rb' },
      { id: 'n1', label: 'get_token()', source_file: 'app_models.rb' },
    ], links: [] }),
  );
  const written: string[] = [];

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: okBoot,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => [{
      suite_kind: 'structural',
      source_digest: 'map-d',
      path_root: '.unitbob/structural/',
      assignment: { blocks: [{ block_id: 'billing', interfaces: [
        { interface_id: 'i1', entrypoints: ['User#get_token'] },
      ] }] },
    }],
    stdout: { write: (chunk) => { written.push(chunk); return true; } },
  });

  const packetPath = join(projectRoot, '.unitbob', 'suite-build', 'packets', 'app_models.rb');
  assert.equal(readFileSync(packetPath, 'utf8'), readFileSync(join(projectRoot, 'app_models.rb'), 'utf8'));
  const text = written.join('');
  assert.match(text, /1 packet \(\d+ bytes\) written to/);
  assert.match(text, /Hand each worker the paths of its packets, never their contents/);
  // The source stays where it was: spec 22 is not touched by a local copy.
  assert.doesNotMatch(text, /uploaded/);
});

test('a run whose entrypoints resolve to nothing says so and still prepares the build', async () => {
  const projectRoot = railsProject();
  const written: string[] = [];

  await suitePrepare(config(projectRoot), ['--no-known-defect'], {
    precheck: okPrecheck,
    bootCheck: okBoot,
    ensureRunner: okRunner,
    runnerEnvelope: okEnvelope,
    getRecipe: async (name) => ({ name, version: 'v1', text: 'recipe' }),
    getSuitePacketsBatch: async () => [{
      suite_kind: 'structural',
      source_digest: 'map-d',
      path_root: '.unitbob/structural/',
      assignment: { blocks: [{ block_id: 'billing', interfaces: [
        { interface_id: 'i1', entrypoints: ['Nowhere#at_all'] },
      ] }] },
    }],
    stdout: { write: (chunk) => { written.push(chunk); return true; } },
  });

  const text = written.join('');
  assert.match(text, /No packet was written this run/);
  assert.match(text, /1 of 1 entrypoints have no packet/);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'suite-build', 'request.json')), true);
});
