import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputPath, writeSuiteBuildRequest, type SuiteBuildBranch } from '../src/files/suiteBuild.ts';
import { runLocal } from '../src/verbs/runLocal.ts';
import { writeTestsRequest, type TestsRequest } from '../src/files/features.ts';
import type { RunnerResult } from '../src/runner/types.ts';
import type { Config } from '../src/config.ts';

// Both generation recipes say "run it locally and iterate before handing it off"
// and both say "the runner command is connector-owned". Until `run-local` there
// was nothing between those two sentences: `check` only runs suites the server
// has already published, which is never true during the loop where the
// iterating happens. On the a2time run of 2026-08-04 the host agent bridged the
// gap by guessing `--require` and `BUNDLE_GEMFILE` from the recipe's file tree.

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-run-local-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

function branches(): SuiteBuildBranch[] {
  return [
    {
      suite_kind: 'structural', source_digest: 'map-d', path_root: '.unitbob/structural/',
      recipe: { name: 'generate', version: 'g1', text: 'g' }, assignment: {},
      runner_manifest: { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' },
    },
    {
      suite_kind: 'behavioral', source_digest: 'surface-d', path_root: '.unitbob/behavioral/',
      recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' }, assignment: {},
      runner_manifest: {
        language: 'ruby', framework: 'cucumber', result_format: 'cucumber_messages',
        runner: 'cucumber', package_manager: 'bundler', runner_version: '9.2.1',
      },
    },
  ];
}

function structuralAnswer(): Record<string, unknown> {
  return {
    suite_kind: 'structural',
    suite_file: { path: '.unitbob/structural/architecture_map_contracts_spec.rb' },
    runner_manifest: { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' },
    test_metadata: { capabilities: [] },
  };
}

function behavioralAnswer(): Record<string, unknown> {
  return {
    suite_kind: 'behavioral',
    suite_file: { path: '.unitbob/behavioral/features/surface_contracts.feature' },
    runner_manifest: {
      language: 'ruby', framework: 'cucumber', result_format: 'cucumber_messages',
      runner: 'cucumber', package_manager: 'bundler', runner_version: '9.2.1',
    },
    test_metadata: { capabilities: [] },
  };
}

// The connector reads a suite's bytes off disk when the answer gives only a
// `path`, so a fixture that skips writing the files is one whose branches are
// all unreadable — a different case, with its own test at the bottom.
function project(answered: Record<string, unknown>[]): string {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'structural'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral', 'features'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.unitbob', 'structural', 'architecture_map_contracts_spec.rb'),
    "require_relative 'unitbob_helper'\n",
  );
  writeFileSync(
    join(projectRoot, '.unitbob', 'behavioral', 'features', 'surface_contracts.feature'),
    'Feature: x\n',
  );
  writeSuiteBuildRequest(projectRoot, branches());
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: answered }));
  return projectRoot;
}

function testsRequest(projectRoot: string, id: number): TestsRequest {
  return {
    project_root: projectRoot,
    recipe: { name: 'feature_tests', version: 'v', text: 't' },
    feature: { feature_id: id, title: 'Comments', status: 'knowledge' },
    feature_tag: `unitbob_feature_${id}`,
    assignment: { capabilities: [] },
    scenarios: [],
    knowledge_path: `.unitbob/features/${id}/knowledge.md`,
    knowledge_digest: 'k',
    runner: 'cucumber',
    runner_manifest: { runner: 'cucumber' },
    main_suite: 'not_built',
    feature_path: `.unitbob/behavioral/features/feature_${id}.feature`,
    steps_path: `.unitbob/behavioral/step_definitions/feature_${id}_steps.rb`,
    output_path: `.unitbob/features/${id}/tests-output.json`,
  };
}

function runnerResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    code: 0, stdout: '124 examples, 3 failures', stderr: '', timedOut: false,
    command: 'bundle', args: ['exec', 'rspec'], resultPath: '.unitbob/structural/rspec_result.json',
    report: '{"examples":[]}',
    ...overrides,
  } as RunnerResult;
}

function collect(): { out: string[]; stdout: { write: (chunk: string) => boolean } } {
  const out: string[] = [];
  return { out, stdout: { write: (chunk: string) => { out.push(String(chunk)); return true; } } };
}

const okStack = { ok: true } as ReturnType<typeof import('../src/runner/precheck.ts').validateStack>;

test('run-local runs every branch the request asked for, with the connector-owned runner', async () => {
  const projectRoot = project([structuralAnswer(), behavioralAnswer()]);
  const ran: string[] = [];
  const { out, stdout } = collect();

  await runLocal(config(projectRoot), [], {
    runStructural: async (_root, runner, suitePath) => { ran.push(`structural:${runner}:${suitePath}`); return runnerResult(); },
    runBehavioral: async (_root, runner, mainPath) => { ran.push(`behavioral:${runner}:${mainPath}`); return runnerResult(); },
    validateStack: () => okStack,
    stdout,
  });

  assert.deepEqual(ran, [
    'structural:rspec:.unitbob/structural/architecture_map_contracts_spec.rb',
    'behavioral:cucumber:.unitbob/behavioral/features/surface_contracts.feature',
  ]);
  assert.match(out.join(''), /── structural ──/);
  assert.match(out.join(''), /── behavioral ──/);
});

// Spec 39, criterion 3. The branch's shared setup file travels as an ordinary
// support file — it has to, or the next materialization wipes it — and every
// support file is otherwise handed to the runner as a path to collect tests
// from. It is not a test and never was: vitest would open it looking for cases,
// find none, and report that as a suite of nothing.
test('the shared setup file is not handed to the runner as a test path', async () => {
  const projectRoot = project([{
    ...structuralAnswer(),
    suite_file: {
      path: '.unitbob/structural/billing.test.ts',
      support_files: [
        { path: '.unitbob/structural/_setup.ts' },
        { path: '.unitbob/structural/reporting.test.ts' },
      ],
    },
  }]);
  for (const name of ['billing.test.ts', '_setup.ts', 'reporting.test.ts']) {
    writeFileSync(join(projectRoot, '.unitbob', 'structural', name), '// x\n');
  }
  let given: string[] = [];
  const { stdout } = collect();

  await runLocal(config(projectRoot), ['structural'], {
    runStructural: async (_root, _runner, suitePaths) => { given = suitePaths; return runnerResult(); },
    runBehavioral: async () => runnerResult(),
    validateStack: () => okStack,
    stdout,
  });

  assert.deepEqual(given, ['.unitbob/structural/billing.test.ts', '.unitbob/structural/reporting.test.ts']);
});

// The command, on every run including a green one. It is the answer to "how do I
// run that again", which is what the whole iteration loop is made of.
test('run-local prints the exact command, the exit code and where the report landed', async () => {
  const projectRoot = project([structuralAnswer()]);
  const { out, stdout } = collect();

  await runLocal(config(projectRoot), ['structural'], {
    runStructural: async () => runnerResult({
      command: 'bundle',
      args: ['exec', 'rspec', '.unitbob/structural/x_spec.rb', '--format', 'json'],
      code: 1,
    }),
    runBehavioral: async () => runnerResult(),
    validateStack: () => okStack,
    stdout,
  });

  const printed = out.join('');
  assert.match(printed, /ran: bundle exec rspec \.unitbob\/structural\/x_spec\.rb --format json/);
  assert.match(printed, /exit code: 1/);
  assert.match(printed, /machine-readable report: \.unitbob\/structural\/rspec_result\.json/);
  assert.match(printed, /124 examples, 3 failures/);
});

// A run that produced no report died before the first test. Saying which of the
// two happened is the difference between "your tests fail" and "your suite never
// started", and the recipes treat those as opposite outcomes.
test('run-local distinguishes a run with no report from failing tests', async () => {
  const projectRoot = project([structuralAnswer()]);
  const { out, stdout } = collect();

  await runLocal(config(projectRoot), ['structural'], {
    runStructural: async () => runnerResult({ report: '', code: 1, stderr: 'LoadError: cannot load such file' }),
    runBehavioral: async () => runnerResult(),
    validateStack: () => okStack,
    stdout,
  });

  assert.match(out.join(''), /died before the first test/);
  assert.match(out.join(''), /LoadError/);
});

// Halfway through a build is the normal state, not an error: the peer branch
// still runs, and the message says where to put the missing one.
test('run-local says what is missing for a branch not written yet, and runs the peer', async () => {
  const projectRoot = project([structuralAnswer()]);
  const ran: string[] = [];
  const { out, stdout } = collect();

  await runLocal(config(projectRoot), [], {
    runStructural: async () => { ran.push('structural'); return runnerResult(); },
    runBehavioral: async () => { ran.push('behavioral'); return runnerResult(); },
    validateStack: () => okStack,
    stdout,
  });

  assert.deepEqual(ran, ['structural']);
  assert.match(out.join(''), /no entry for this branch yet/);
  assert.match(out.join(''), /\.unitbob\/behavioral\//);
});

test('run-local does not try to run a branch the answer declined', async () => {
  const projectRoot = project([
    structuralAnswer(),
    { suite_kind: 'behavioral', build_error: { message: 'ran out of budget after the feature file' } },
  ]);
  const ran: string[] = [];
  const { out, stdout } = collect();

  await runLocal(config(projectRoot), [], {
    runStructural: async () => { ran.push('structural'); return runnerResult(); },
    runBehavioral: async () => { ran.push('behavioral'); return runnerResult(); },
    validateStack: () => okStack,
    stdout,
  });

  assert.deepEqual(ran, ['structural']);
  assert.match(out.join(''), /ran out of budget after the feature file/);
});

// A stack mismatch belongs to one branch. The peer is a different language's
// problem or no problem at all, and stopping the command would make it one.
test('run-local reports a stack mismatch against its own branch and keeps going', async () => {
  const projectRoot = project([structuralAnswer(), behavioralAnswer()]);
  const ran: string[] = [];
  const { out, stdout } = collect();

  await runLocal(config(projectRoot), [], {
    runStructural: async () => { ran.push('structural'); return runnerResult(); },
    runBehavioral: async () => { ran.push('behavioral'); return runnerResult(); },
    validateStack: (_root, runner) =>
      (runner === 'rspec' ? { ok: false, message: 'no Gemfile here' } : { ok: true }) as typeof okStack,
    stdout,
  });

  assert.deepEqual(ran, ['behavioral']);
  assert.match(out.join(''), /no Gemfile here/);
});

test('run-local refuses a branch name this build never asked for', async () => {
  const projectRoot = project([structuralAnswer()]);

  await assert.rejects(
    runLocal(config(projectRoot), ['bahavioral'], { validateStack: () => okStack, stdout: collect().stdout }),
    /no branch called bahavioral.*structural, behavioral/s,
  );
});

// The file named in the answer is not on disk. Catching it here is the point:
// left to the runner it becomes "0 scenarios" or "no examples found" partway
// through the loop, which reads like a suite that ran and found nothing.
test('run-local separates an entry it cannot read from a branch not written yet', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeSuiteBuildRequest(projectRoot, branches());
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [structuralAnswer()] }));

  const ran: string[] = [];
  const { out, stdout } = collect();

  await runLocal(config(projectRoot), [], {
    runStructural: async () => { ran.push('structural'); return runnerResult(); },
    runBehavioral: async () => { ran.push('behavioral'); return runnerResult(); },
    validateStack: () => okStack,
    stdout,
  });

  assert.deepEqual(ran, []);
  assert.match(out.join(''), /could not be read/);
  assert.match(out.join(''), /no entry for this branch yet/);
});

// Spec 34-6, criterion 3. `repair_rounds` is gone, and with it the only thing
// that could ever end a repair loop. This is the replacement, and unlike a round
// count it is silent for as long as the edits are doing something.
const RED = JSON.stringify({
  examples: [
    { description: 'ubc_0123456789ab guards checkout', file_path: './a_spec.rb', status: 'failed',
      exception: { message: 'expected 200, got 500\n  at line 4' } },
  ],
});

// A different first line of the same message is a different failure: the repair
// moved, even if the case is still red.
const MOVED = JSON.stringify({
  examples: [
    { description: 'ubc_0123456789ab guards checkout', file_path: './a_spec.rb', status: 'failed',
      exception: { message: 'expected 200, got 422\n  at line 4' } },
  ],
});

async function runWithReport(projectRoot: string, report: string): Promise<{ code: number; out: string }> {
  const { out, stdout } = collect();
  const code = await runLocal(config(projectRoot), ['structural'], {
    runStructural: async () => runnerResult({ code: 1, report }),
    runBehavioral: async () => runnerResult(),
    validateStack: () => okStack,
    stdout,
  });
  return { code, out: out.join('') };
}

test('the first run of a branch always passes: there is nothing to compare it to', async () => {
  const projectRoot = project([structuralAnswer(), behavioralAnswer()]);

  const first = await runWithReport(projectRoot, RED);

  assert.equal(first.code, 0);
  assert.doesNotMatch(first.out, /Stopping structural/);
});

test('the same set of failures twice in a row stops the branch with a non-zero code', async () => {
  const projectRoot = project([structuralAnswer(), behavioralAnswer()]);
  await runWithReport(projectRoot, RED);

  const second = await runWithReport(projectRoot, RED);

  assert.equal(second.code, 1);
  assert.match(second.out, /Stopping structural/);
  assert.match(second.out, /changed nothing this run can see/);
});

// The count is what the reader just saw listed. The compared set folds cases
// sharing a marker, a file and a first line into one entry, and printing its
// size under a list of seven Scenarios read as a counting error on soul,
// 2026-09-11.
test('the stop line counts the failed cases it just listed, not the folded set', async () => {
  const same = (name: string) => ({
    description: `ubc_0123456789ab ${name}`, file_path: './a_spec.rb', status: 'failed',
    exception: { message: 'TypeError: request is not a function\n  at line 4' },
  });
  const seven = JSON.stringify({ examples: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(same) });
  const projectRoot = project([structuralAnswer(), behavioralAnswer()]);
  await runWithReport(projectRoot, seven);

  const second = await runWithReport(projectRoot, seven);

  assert.match(second.out, /it just failed the same 7 case\(s\) as the previous run/);
});

test('a failure that changed its message is progress, and the branch keeps running', async () => {
  const projectRoot = project([structuralAnswer(), behavioralAnswer()]);
  await runWithReport(projectRoot, RED);

  const second = await runWithReport(projectRoot, MOVED);

  assert.equal(second.code, 0);
  assert.doesNotMatch(second.out, /Stopping structural/);
});

// The set belongs to the branch, so polishing the structural peer must not stop
// the behavioral one, and the two counters never touch.
test('the two branches remember their failures separately', async () => {
  const projectRoot = project([structuralAnswer(), behavioralAnswer()]);
  await runWithReport(projectRoot, RED);
  await runWithReport(projectRoot, RED);

  const { out, stdout } = collect();
  const code = await runLocal(config(projectRoot), ['behavioral'], {
    runStructural: async () => runnerResult(),
    runBehavioral: async () => runnerResult({ code: 1, report: RED }),
    validateStack: () => okStack,
    stdout,
  });

  assert.equal(code, 0);
  assert.doesNotMatch(out.join(''), /Stopping/);
});

// Every `run-local` is a separate `npx` process, so a set held in memory would
// reset on each one and compare nothing at all.
test('the remembered failures survive the process that ran them', async () => {
  const projectRoot = project([structuralAnswer(), behavioralAnswer()]);
  await runWithReport(projectRoot, RED);

  const state = JSON.parse(readFileSync(join(projectRoot, '.unitbob', 'suite-build', 'run-state.json'), 'utf8'));
  assert.equal(typeof state.branches.structural, 'string');
  assert.equal(state.branches.behavioral, undefined);
});

// A green branch is not a branch that has stopped moving, and remembering an
// empty set would stop one that passes twice.
test('a branch that goes green is forgotten rather than remembered', async () => {
  const projectRoot = project([structuralAnswer(), behavioralAnswer()]);
  await runWithReport(projectRoot, RED);

  const green = await runWithReport(projectRoot, '{"examples":[]}');
  const again = await runWithReport(projectRoot, '{"examples":[]}');

  assert.equal(green.code, 0);
  assert.equal(again.code, 0);
  const state = JSON.parse(readFileSync(join(projectRoot, '.unitbob', 'suite-build', 'run-state.json'), 'utf8'));
  assert.equal(state.branches.structural, undefined);
});

// A run that produced no readable report never reached the loop this bounds: it
// is a harness problem. Comparing against the set from before the harness broke
// would stop a branch for the wrong reason.
test('a run with no readable report forgets the branch instead of matching it', async () => {
  const projectRoot = project([structuralAnswer(), behavioralAnswer()]);
  await runWithReport(projectRoot, RED);

  const died = await runWithReport(projectRoot, '');
  const back = await runWithReport(projectRoot, RED);

  assert.equal(died.code, 0);
  assert.equal(back.code, 0);
});

// Refusing to run over damaged bookkeeping would turn the one soft stop in the
// loop into the hardest thing in it.
test('a damaged run-state file reads as "no previous run"', async () => {
  const projectRoot = project([structuralAnswer(), behavioralAnswer()]);
  await runWithReport(projectRoot, RED);
  writeFileSync(join(projectRoot, '.unitbob', 'suite-build', 'run-state.json'), '{"branches":{"struc');

  const next = await runWithReport(projectRoot, RED);

  assert.equal(next.code, 0);
  assert.doesNotMatch(next.out, /Stopping structural/);
});

// Spec 37-2, criterion 5. The connector already parses all five report formats
// for the stall comparison, and until now printed none of what it found — so the
// coordinator reopened `pytest_bdd_report.json` and `pytest_result.xml` with
// inline `node -e` and `python3`, on the turns where its own context is largest.
// On the microblog bench that stretch cost 79 coordinator turns and 47% of its
// input tokens.
test('a red run is read out: which case, which file, and what it said', async () => {
  const projectRoot = project([structuralAnswer()]);
  const { out, stdout } = collect();
  const report = JSON.stringify({
    examples: [
      {
        description: 'ubc_0123456789ab charges the card',
        full_description: 'Checkout ubc_0123456789ab charges the card',
        file_path: './.unitbob/structural/checkout_spec.rb',
        status: 'failed',
        exception: { message: 'expected 200, got 500\n  ./app/pay.rb:12', backtrace: ['./app/pay.rb:12'] },
      },
      { description: 'ubc_ba9876543210 refunds', file_path: './x_spec.rb', status: 'passed' },
    ],
  });

  await runLocal(config(projectRoot), ['structural'], {
    runStructural: async () => runnerResult({ report, code: 1 }),
    runBehavioral: async () => runnerResult(),
    validateStack: () => okStack,
    stdout,
  });

  const printed = out.join('');
  assert.match(printed, /1 case failed, read out of \.unitbob\/structural\/rspec_result\.json/);
  assert.match(printed, /Do not open that file to find this again/);
  assert.match(printed, /Checkout ubc_0123456789ab charges the card — \.\/\.unitbob\/structural\/checkout_spec\.rb/);
  assert.match(printed, /expected 200, got 500/);
  assert.match(printed, /\.\/app\/pay\.rb:12/);
  // A passing example is not read out.
  assert.doesNotMatch(printed, /refunds/);
});

test('a green run is read out as nothing at all', async () => {
  const projectRoot = project([structuralAnswer()]);
  const { out, stdout } = collect();

  await runLocal(config(projectRoot), ['structural'], {
    runStructural: async () => runnerResult({ report: '{"examples":[]}' }),
    runBehavioral: async () => runnerResult(),
    validateStack: () => okStack,
    stdout,
  });

  assert.doesNotMatch(out.join(''), /cases? failed, read out of/);
});

// The step is half the answer to "where do I look", and it is the half a
// structural runner cannot give — so it appears exactly where the format has one.
test('a red behavioral run also names the step the scenario broke on', async () => {
  const projectRoot = project([behavioralAnswer()]);
  const { out, stdout } = collect();
  const report = [
    { pickle: { id: 'p1', name: 'A shopper pays', uri: '.unitbob/behavioral/features/pay.feature',
      tags: [{ name: '@ubc_0123456789ab' }], steps: [{ id: 'ps1', text: 'the buyer confirms the cart' }] } },
    { testCase: { id: 'tc1', pickleId: 'p1', testSteps: [{ id: 's1', pickleStepId: 'ps1' }] } },
    { testCaseStarted: { id: 'run1', testCaseId: 'tc1' } },
    { testStepFinished: { testCaseStartedId: 'run1', testStepId: 's1',
      testStepResult: { status: 'FAILED', message: 'NoMethodError: undefined method `total\'' } } },
  ].map((line) => JSON.stringify(line)).join('\n');

  await runLocal(config(projectRoot), ['behavioral'], {
    runStructural: async () => runnerResult(),
    runBehavioral: async () => runnerResult({ report, code: 1, resultPath: '.unitbob/behavioral/cucumber_messages.ndjson' }),
    validateStack: () => okStack,
    stdout,
  });

  const printed = out.join('');
  assert.match(printed, /A shopper pays — \.unitbob\/behavioral\/features\/pay\.feature/);
  assert.match(printed, /step: the buyer confirms the cart/);
  assert.match(printed, /NoMethodError: undefined method/);
});

// The full backtrace stays in the report file this line already names; what is
// printed is bounded, and says so rather than trailing off.
test('a very long message is cut short in the open', async () => {
  const projectRoot = project([structuralAnswer()]);
  const { out, stdout } = collect();
  const report = JSON.stringify({
    examples: [{
      description: 'ubc_0123456789ab charges', full_description: 'Checkout charges',
      file_path: './x_spec.rb', status: 'failed',
      exception: { message: ['line one', ...Array.from({ length: 40 }, (_, i) => `frame ${i}`)].join('\n') },
    }],
  });

  await runLocal(config(projectRoot), ['structural'], {
    runStructural: async () => runnerResult({ report, code: 1 }),
    runBehavioral: async () => runnerResult(),
    validateStack: () => okStack,
    stdout,
  });

  const printed = out.join('');
  assert.match(printed, /line one/);
  assert.match(printed, /…/);
  assert.doesNotMatch(printed, /frame 39/);
});

// The run this read-out most exists for is the first red one, where the harness
// is not wired and every case fails. Unbounded, that is half a megabyte into the
// context this spec exists to make cheaper — so the block is capped, and what
// did not fit is counted rather than dropped in silence.
test('a branch where everything failed is bounded, and says how much it left out', async () => {
  const projectRoot = project([structuralAnswer()]);
  const { out, stdout } = collect();
  const report = JSON.stringify({
    examples: Array.from({ length: 400 }, (_, i) => ({
      description: `ubc_${String(i).padStart(12, '0')} guards`,
      full_description: `Checkout guards case number ${i} of the whole branch`,
      file_path: `./.unitbob/structural/case_${i}_spec.rb`,
      status: 'failed',
      exception: { message: `NameError: uninitialized constant Something${i}\n  ./app/x.rb:1` },
    })),
  });

  await runLocal(config(projectRoot), ['structural'], {
    runStructural: async () => runnerResult({ report, code: 1 }),
    runBehavioral: async () => runnerResult(),
    validateStack: () => okStack,
    stdout,
  });

  const printed = out.join('');
  assert.match(printed, /400 cases failed, read out of/);
  assert.match(printed, /…and \d+ more failed cases, not printed to keep this readable/);
  assert.ok(printed.length < 60_000, `the read-out ran to ${printed.length} characters`);
  // The ones that were printed are whole, not cut mid-failure.
  assert.match(printed, /1\. Checkout guards case number 0 of the whole branch/);
});

// Spec 52-3, AC 3.2 and 3.3. Without a flag, `run-local` leaves the feature
// tags the build request names out of the behavioral run — it asks no server.
// With `--feature <id>` it runs only that feature's tag, on the files as they
// lie, with the runner of the feature's own request, and materialises nothing.
test('run-local without a flag excludes the feature tags the build request carries, then runs each tag on its own', async () => {
  const projectRoot = project([behavioralAnswer()]);
  writeSuiteBuildRequest(projectRoot, branches(), { status: 'not_supplied' }, ['unitbob_feature_12', 'unitbob_feature_15']);
  const filters: unknown[] = [];
  const { out, stdout } = collect();

  await runLocal(config(projectRoot), ['behavioral'], {
    runBehavioral: async (_root, _runner, _main, f) => {
      filters.push(f);
      return f && 'only' in f && f.only === 'unitbob_feature_12' ? runnerResult({ code: 1, report: RED_FEATURE }) : runnerResult();
    },
    validateStack: () => okStack, stdout,
  });

  // Spec 52-4, AC 1.1: the same order `check` runs them in — the main suite
  // with every tag excluded, then each feature by its tag — and each feature's
  // run read out locally like the rest.
  assert.deepEqual(filters, [
    { exclude: ['unitbob_feature_12', 'unitbob_feature_15'] },
    { only: 'unitbob_feature_12' },
    { only: 'unitbob_feature_15' },
  ]);
  const printed = out.join('');
  assert.match(printed, /── behavioral ──[\s\S]*── unitbob_feature_12 ──[\s\S]*1 case failed[\s\S]*── unitbob_feature_15 ──/);
});

test('a feature tag whose runner fails is printed and stops neither the tags after it nor the exit code', async () => {
  const projectRoot = project([behavioralAnswer()]);
  writeSuiteBuildRequest(projectRoot, branches(), { status: 'not_supplied' }, ['unitbob_feature_12', 'unitbob_feature_15']);
  const filters: unknown[] = [];
  const { out, stdout } = collect();

  const code = await runLocal(config(projectRoot), ['behavioral'], {
    runBehavioral: async (_root, _runner, _main, f) => {
      filters.push(f);
      if (f && 'only' in f && f.only === 'unitbob_feature_12') throw new Error('cucumber: command not found');
      return runnerResult();
    },
    validateStack: () => okStack, stdout,
  });

  assert.equal(code, 0);
  assert.equal(filters.length, 3);
  assert.match(out.join(''), /The runner could not start: cucumber: command not found/);
});

test('run-local without a flag reads a request written before the tags existed as no exclusion', async () => {
  const projectRoot = project([behavioralAnswer()]);
  let filter: unknown = 'unset';

  await runLocal(config(projectRoot), ['behavioral'], {
    runBehavioral: async (_root, _runner, _main, f) => { filter = f; return runnerResult(); },
    validateStack: () => okStack, stdout: collect().stdout,
  });

  assert.deepEqual(filter, { exclude: [] });
});

test('run-local --feature runs only that feature’s tag with its own runner, reading no build request', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral', 'features'), { recursive: true });
  writeTestsRequest(projectRoot, 12, testsRequest(projectRoot, 12));
  const ran: string[] = [];
  const { out, stdout } = collect();

  const code = await runLocal(config(projectRoot), ['--feature', '12'], {
    runBehavioral: async (_root, runner, mainPath, f) => { ran.push(`${runner}:${mainPath}:${JSON.stringify(f)}`); return runnerResult({ code: 1, report: RED_FEATURE }); },
    runStructural: async () => { ran.push('structural'); return runnerResult(); },
    validateStack: () => okStack, stdout,
  });

  assert.equal(code, 0);
  assert.deepEqual(ran, ['cucumber:.unitbob/behavioral/features/feature_12.feature:{"only":"unitbob_feature_12"}']);
  assert.match(out.join(''), /── feature 12 ──/);
  assert.match(out.join(''), /ran: bundle exec rspec/);
  assert.match(out.join(''), /1 case failed/);
});

test('run-local --feature says what is missing when the feature was never prepared', async () => {
  await assert.rejects(
    () => runLocal(config(tmpProject()), ['--feature', '12'], { validateStack: () => okStack, stdout: collect().stdout }),
    /tests-request\.json not found — run `npx unitbob tests-prepare 12` first/,
  );
});

// One red scenario of the feature, as cucumber reports it.
const RED_FEATURE = [
  JSON.stringify({ pickle: { id: 'p1', name: 'A reader comments', tags: [{ name: '@ubc_0123456789ab' }, { name: '@unitbob_feature_12' }], steps: [] } }),
  JSON.stringify({ testCase: { id: 'tc1', pickleId: 'p1', testSteps: [{ id: 'ts1' }] } }),
  JSON.stringify({ testCaseStarted: { id: 'tcs1', testCaseId: 'tc1' } }),
  JSON.stringify({ testStepFinished: { testCaseStartedId: 'tcs1', testStepId: 'ts1', testStepResult: { status: 'FAILED', message: 'no comment' } } }),
  JSON.stringify({ testCaseFinished: { testCaseStartedId: 'tcs1' } }),
].join('\n');
