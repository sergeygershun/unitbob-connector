import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BEHAVIORAL_DIR,
  BEHAVIORAL_WORLD,
  BEHAVIORAL_WORLD_PATH,
  behavioralWorldFor,
  filesLostOnMaterialize,
  materializeBehavioral,
} from '../src/files/behavioral.ts';
import type { SuiteArtifact } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-behavioral-'));
}

function artifact(): SuiteArtifact {
  return {
    path: '.unitbob/behavioral/features/surface_contracts.feature',
    content: 'Feature: What the product does\n',
    support_files: [
      { path: '.unitbob/behavioral/step_definitions/surface_steps.rb', content: "Given('a shopper') {}\n" },
    ],
  };
}

test('materializes the .feature and every support file under the behavioral root', () => {
  const projectRoot = tmpProject();
  const { mainPath } = materializeBehavioral(projectRoot, artifact(), 'cucumber');

  assert.equal(readFileSync(mainPath, 'utf8'), 'Feature: What the product does\n');
  assert.equal(
    readFileSync(join(projectRoot, BEHAVIORAL_DIR, 'step_definitions', 'surface_steps.rb'), 'utf8'),
    "Given('a shopper') {}\n",
  );
  assert.equal(readFileSync(join(projectRoot, BEHAVIORAL_WORLD_PATH), 'utf8'), BEHAVIORAL_WORLD);
});

test('restores the connector-owned Ruby World byte-for-byte on every materialization', () => {
  const projectRoot = tmpProject();
  materializeBehavioral(projectRoot, artifact(), 'cucumber');
  writeFileSync(join(projectRoot, BEHAVIORAL_WORLD_PATH), '# host changed it\n');

  materializeBehavioral(projectRoot, artifact(), 'cucumber');

  assert.equal(readFileSync(join(projectRoot, BEHAVIORAL_WORLD_PATH), 'utf8'), BEHAVIORAL_WORLD);
  assert.match(BEHAVIORAL_WORLD, /DO NOT EDIT/);
  assert.doesNotMatch(BEHAVIORAL_WORLD, /render_template|FactoryBot/);
});

test('refuses a host support file at the connector-owned World path before writing anything', () => {
  const projectRoot = tmpProject();
  const collided = artifact();
  collided.support_files?.push({ path: BEHAVIORAL_WORLD_PATH, content: '# mine\n' });

  assert.throws(() => materializeBehavioral(projectRoot, collided, 'cucumber'), /connector-owned World/);
  assert.equal(existsSync(join(projectRoot, BEHAVIORAL_DIR)), false);
});

test('refuses a file that escapes the behavioral root and writes nothing', () => {
  const projectRoot = tmpProject();
  const escaped = { ...artifact(), path: 'features/pwned.feature' };

  assert.throws(() => materializeBehavioral(projectRoot, escaped, 'cucumber'), /\.unitbob\/behavioral\//);
  assert.equal(existsSync(join(projectRoot, BEHAVIORAL_DIR)), false);
});

test('wipes a stale file from a previous version before writing the new suite', () => {
  const projectRoot = tmpProject();
  const stale = join(projectRoot, BEHAVIORAL_DIR, 'features', 'old.feature');
  mkdirSync(join(projectRoot, BEHAVIORAL_DIR, 'features'), { recursive: true });
  writeFileSync(stale, 'Feature: the old one\n');

  materializeBehavioral(projectRoot, artifact(), 'cucumber');

  assert.equal(existsSync(stale), false);
  assert.equal(
    existsSync(join(projectRoot, BEHAVIORAL_DIR, 'features', 'surface_contracts.feature')),
    true,
  );
});

test('keeps only the Ruby runner environment when refreshing a Cucumber suite', () => {
  const projectRoot = tmpProject();
  const behavioralRoot = join(projectRoot, BEHAVIORAL_DIR);
  const sidecarGemfile = join(behavioralRoot, 'Gemfile');
  const sidecarLockfile = join(behavioralRoot, 'Gemfile.lock');
  const staleNodeModules = join(behavioralRoot, 'node_modules', 'stale');
  mkdirSync(behavioralRoot, { recursive: true });
  mkdirSync(staleNodeModules, { recursive: true });
  writeFileSync(sidecarGemfile, 'gem "cucumber", "9.2.1"\n');
  writeFileSync(sidecarLockfile, 'GEM\n');

  materializeBehavioral(projectRoot, artifact(), 'cucumber');

  assert.equal(readFileSync(sidecarGemfile, 'utf8'), 'gem "cucumber", "9.2.1"\n');
  assert.equal(readFileSync(sidecarLockfile, 'utf8'), 'GEM\n');
  assert.equal(existsSync(staleNodeModules), false);
});

test('keeps only the JavaScript runner environment when refreshing a Cucumber JS suite', () => {
  const projectRoot = tmpProject();
  const behavioralRoot = join(projectRoot, BEHAVIORAL_DIR);
  const sidecarPackage = join(behavioralRoot, 'package.json');
  const sidecarBin = join(behavioralRoot, 'node_modules', '.bin', 'cucumber-js');
  const staleVenv = join(behavioralRoot, '.venv', 'stale');
  mkdirSync(join(behavioralRoot, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(staleVenv, { recursive: true });
  writeFileSync(sidecarPackage, '{"private":true}\n');
  writeFileSync(sidecarBin, 'runner\n');

  materializeBehavioral(projectRoot, artifact(), 'cucumber-js');

  assert.equal(readFileSync(sidecarPackage, 'utf8'), '{"private":true}\n');
  assert.equal(readFileSync(sidecarBin, 'utf8'), 'runner\n');
  assert.equal(existsSync(staleVenv), false);
});

test('keeps only the Python runner environment when refreshing a pytest-bdd suite', () => {
  const projectRoot = tmpProject();
  const behavioralRoot = join(projectRoot, BEHAVIORAL_DIR);
  const sidecarPytest = join(behavioralRoot, '.venv', 'bin', 'pytest');
  const staleNodeModules = join(behavioralRoot, 'node_modules', 'stale');
  mkdirSync(join(behavioralRoot, '.venv', 'bin'), { recursive: true });
  mkdirSync(staleNodeModules, { recursive: true });
  writeFileSync(sidecarPytest, 'runner\n');

  materializeBehavioral(projectRoot, artifact(), 'pytest-bdd');

  assert.equal(readFileSync(sidecarPytest, 'utf8'), 'runner\n');
  assert.equal(existsSync(staleNodeModules), false);
});

// The connector's own BDD run writes its report — and, for pytest-bdd, the
// harness it drives the run with — into the behavioral root. Materialization is
// right to clear them, because the next run rewrites them. Warning about them is
// not: it named the connector's files as the user's loss, on every single
// review, which is how a genuinely forgotten step file learns to look like noise.
test('the lost-file warning ignores the connector run artifacts it writes itself', () => {
  const root = tmpProject();
  const artifact: SuiteArtifact = {
    path: '.unitbob/behavioral/features/surface_contracts.feature',
    content: 'Feature: billing\n',
  };
  materializeBehavioral(root, artifact, 'cucumber');
  for (const name of [
    'cucumber_messages.ndjson',
    'pytest_bdd_report.json',
    'unitbob_pytest_bdd_plugin.py',
    'pytest.ini',
  ]) {
    writeFileSync(join(root, '.unitbob', 'behavioral', name), 'run output');
  }

  assert.deepEqual(filesLostOnMaterialize(root, artifact, 'cucumber'), []);
});

test('the lost-file warning does not call the connector-owned World a forgotten host file', () => {
  const projectRoot = tmpProject();
  materializeBehavioral(projectRoot, artifact(), 'cucumber');

  assert.deepEqual(filesLostOnMaterialize(projectRoot, artifact(), 'cucumber'), []);
});

// The whole point of the warning still has to fire: a step file the answer
// forgot is about to be deleted, and its steps come back undefined.
test('the lost-file warning still names a step file the answer forgot', () => {
  const root = tmpProject();
  const artifact: SuiteArtifact = {
    path: '.unitbob/behavioral/features/surface_contracts.feature',
    content: 'Feature: billing\n',
  };
  materializeBehavioral(root, artifact, 'cucumber');
  writeFileSync(join(root, '.unitbob', 'behavioral', 'cucumber_messages.ndjson'), 'run output');
  mkdirSync(join(root, '.unitbob', 'behavioral', 'step_definitions'), { recursive: true });
  writeFileSync(join(root, '.unitbob', 'behavioral', 'step_definitions', 'billing_steps.rb'), '# steps');

  assert.deepEqual(
    filesLostOnMaterialize(root, artifact, 'cucumber'),
    ['.unitbob/behavioral/step_definitions/billing_steps.rb'],
  );
});

// Spec 35-1, criterion 2. Cucumber loads neither `spec/rails_helper.rb` nor
// `spec/support/**`, so every switch a project's RSpec setup throws was still
// off on the behavioral branch — WebMock among them, which means outgoing HTTP
// was reaching the real network while the structural branch had it blocked. No
// step said so; the two branches simply behaved differently.
test('the connector-owned World turns on the framework switches Cucumber never reaches', () => {
  assert.match(BEHAVIORAL_WORLD, /webmock/i, 'WebMock must be enabled');
  assert.match(BEHAVIORAL_WORLD, /disable_net_connect!/);
  assert.match(BEHAVIORAL_WORLD, /Sidekiq::Testing\.fake!/);
  assert.match(BEHAVIORAL_WORLD, /queue_adapter = :test/);
  assert.match(BEHAVIORAL_WORLD, /default_url_options/);
  // The reason the file names, so the next reader does not have to find it out
  // the way we did.
  assert.match(BEHAVIORAL_WORLD, /rails_helper/);
  assert.match(BEHAVIORAL_WORLD, /spec\/support/);
});

// A rule, not an oversight, and the reason is mechanical: Cucumber loads every
// step file in the bundle into one flat namespace, so a step defined here would
// not merely risk colliding with a worker's — it would collide, and the run
// would stop on an ambiguous match instead of failing readably.
test('the connector-owned World defines no step at all, and says why', () => {
  for (const keyword of ['Given', 'When', 'Then', 'And', 'But']) {
    assert.doesNotMatch(
      BEHAVIORAL_WORLD,
      new RegExp(`^\\s*${keyword}\\s*[('/]`, 'm'),
      `${keyword} is a step definition — steps here collide with the workers' own`,
    );
  }
  assert.match(BEHAVIORAL_WORLD, /flat namespace/i);
  // Application-specific setup stays host-owned shared steps: login, factories,
  // reading props, provider stubs.
  assert.doesNotMatch(BEHAVIORAL_WORLD, /FactoryBot|sign_in|login/i);
});

// Spec 35-1, criterion 2, widened to every stack Unitbob supports. The gap was
// found on Ruby, but none of the three BDD runners reads its project's own test
// bootstrap, so on all three the behavioral branch was reaching the real network
// while its structural peer was not.
const HARNESSED_RUNNERS = ['cucumber', 'cucumber-js', 'pytest-bdd'] as const;

test('every behavioral runner gets a connector-owned harness the runner actually loads', () => {
  assert.equal(behavioralWorldFor('cucumber')?.path, '.unitbob/behavioral/step_definitions/00_unitbob_world.rb');
  // cucumber-js `require()`s the whole step_definitions directory; `00_` sorts
  // first, exactly as on Ruby.
  assert.equal(behavioralWorldFor('cucumber-js')?.path, '.unitbob/behavioral/step_definitions/00_unitbob_world.js');
  // pytest loads every conftest.py from the rootdir down to the collected
  // directory. This one sits a level above `step_definitions/`, which leaves the
  // host's own `step_definitions/conftest.py` — the home the step-loading rules
  // already promise them for shared fixtures — untouched.
  assert.equal(behavioralWorldFor('pytest-bdd')?.path, '.unitbob/behavioral/conftest.py');
  assert.equal(behavioralWorldFor('rspec'), undefined);
});

test('every connector-owned harness refuses connections that leave the machine, and says so', () => {
  for (const runner of HARNESSED_RUNNERS) {
    const world = behavioralWorldFor(runner)!;
    assert.match(world.content, /DO NOT EDIT/, runner);
    assert.match(world.content, /localhost/i, runner);
    // Each one names what its runner does not load, in that runner's own terms.
    assert.match(world.content, /spec 35-1/i, runner);
  }
  assert.match(behavioralWorldFor('cucumber-js')!.content, /net\.Socket\.prototype\.connect/);
  assert.match(behavioralWorldFor('pytest-bdd')!.content, /socket\.socket\.connect/);
});

test('no connector-owned harness defines a step, on any stack', () => {
  for (const runner of HARNESSED_RUNNERS) {
    const { content } = behavioralWorldFor(runner)!;
    for (const keyword of ['Given', 'When', 'Then']) {
      assert.doesNotMatch(content, new RegExp(`^\\s*${keyword}\\s*[('/]`, 'm'), `${runner}: ${keyword}`);
      assert.doesNotMatch(content, new RegExp(`^\\s*@${keyword.toLowerCase()}\\(`, 'm'), `${runner}: @${keyword}`);
    }
    // Nothing application-specific either: signing in, fixtures and provider
    // stubs stay host-owned shared steps on every stack.
    assert.doesNotMatch(content, /FactoryBot|sign_in|login/i, runner);
  }
  // The reason is written down where the next reader will be standing.
  assert.match(behavioralWorldFor('cucumber')!.content, /flat namespace/i);
  assert.match(behavioralWorldFor('cucumber-js')!.content, /flat namespace/i);
});

test('the harness is restored for every runner that has one, and never supplied by the host', () => {
  for (const runner of HARNESSED_RUNNERS) {
    const world = behavioralWorldFor(runner)!;
    const projectRoot = tmpProject();

    materializeBehavioral(projectRoot, artifact(), runner);
    assert.equal(readFileSync(join(projectRoot, world.path), 'utf8'), world.content, runner);

    writeFileSync(join(projectRoot, world.path), '# host changed it\n');
    materializeBehavioral(projectRoot, artifact(), runner);
    assert.equal(readFileSync(join(projectRoot, world.path), 'utf8'), world.content, runner);

    const collided = artifact();
    collided.support_files?.push({ path: world.path, content: '# mine\n' });
    assert.throws(() => materializeBehavioral(tmpProject(), collided, runner), /connector-owned World/, runner);

    // And it is never reported to the user as a file of theirs about to be lost.
    assert.equal(filesLostOnMaterialize(projectRoot, artifact(), runner).includes(world.path), false, runner);
  }
});
