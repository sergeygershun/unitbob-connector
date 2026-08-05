import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputPath, writeSuiteBuildRequest, type SuiteBuildBranch } from '../src/files/suiteBuild.ts';
import { runLocal } from '../src/verbs/runLocal.ts';
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
