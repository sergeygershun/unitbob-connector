import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executable } from '../proc.ts';
import { projectRootAsSeenByThePlace, runInProject, type ProjectRun } from './place.ts';
import { commandFileOnHost } from './toolchain.ts';
import { clearReport, readFreshReport, type RunnerResult } from './types.ts';
import { PYTEST_BDD_PLUGIN } from './pytestBddPlugin.ts';

export const BDD_TIMEOUT_MS = 10 * 60 * 1000;

// The behavioral suite lives under one root; the report is written inside it so
// the app under test cannot pollute it and it travels with the suite.
//
// Spelled here rather than imported from `files/behavioral.ts`, which spells it
// too: that module imports this one, and an import back would be a cycle whose
// only symptom is a use-before-initialization at load time.
const BEHAVIORAL_ROOT = '.unitbob/behavioral';

// The sidecar Gemfile bundler is pointed at, in one place — the world probe
// needs the same value and used to carry its own copy. A plain string rather
// than `join`: this path is read where the run happens, whose separator is not
// necessarily this machine's.
export const BEHAVIORAL_GEMFILE = `${BEHAVIORAL_ROOT}/Gemfile`;

const CUCUMBER_REPORT_NAME = 'cucumber_messages.ndjson';
const PYTEST_BDD_REPORT_NAME = 'pytest_bdd_report.json';
const PYTEST_BDD_PLUGIN_NAME = 'unitbob_pytest_bdd_plugin.py';
const PYTEST_INI_NAME = 'pytest.ini';

// Everything a run writes into that root, listed once here — where it is
// written. The review's "these files will be lost" warning reads this list to
// stay quiet about them (see `files/behavioral.ts`). A second hand-kept copy
// drifts the moment a strategy gains a file, and the warning goes back to
// shouting about the connector's own output.
export const BDD_RUN_ARTIFACTS: readonly string[] = [
  CUCUMBER_REPORT_NAME,
  PYTEST_BDD_REPORT_NAME,
  PYTEST_BDD_PLUGIN_NAME,
  PYTEST_INI_NAME,
];

// One name for the directory every strategy points its loader at, so the
// descriptors below and the commands below them cannot come to mean different
// directories.
const STEP_DEFINITIONS = 'step_definitions';

const CUCUMBER_REPORT = join(BEHAVIORAL_ROOT, CUCUMBER_REPORT_NAME);
const PYTEST_BDD_REPORT = join(BEHAVIORAL_ROOT, PYTEST_BDD_REPORT_NAME);
const PYTEST_BDD_PLUGIN_FILE = join(BEHAVIORAL_ROOT, PYTEST_BDD_PLUGIN_NAME);
const PYTEST_INI_FILE = join(BEHAVIORAL_ROOT, PYTEST_INI_NAME);
const PYTEST_INI = '[pytest]\naddopts =\n';

// What a step file has to be for a strategy to load and execute it — the two
// facts a writer needs before writing one, stated by the side that does the
// loading (spec ask-before-you-spend, §3).
//
// These used to be retold in the generation recipe, and on pytest the retelling
// was wrong: it named `<capability>_steps.py`, which pytest does not collect. A
// file written to that name would not have failed — it would have loaded
// nothing, and the run would have been green over no scenarios at all. Two
// coordinators on two different stacks independently opened `dist/runner/bdd.js`
// in the npx cache to find out the truth, which is the whole diagnosis: the rule
// was only knowable here.
//
// So it lives here, in the same table the command lives in, for the reason
// `BDD_RUN_ARTIFACTS` above gives: a second hand-kept copy drifts the moment a
// strategy changes, and this one had already drifted.
export interface BddStepLoading {
  // What a step file must be named for this runner to load it *and* execute it.
  // Put the capability id where the `*` is and you have the file's name. Null
  // when a strategy's rule is not one pattern: then it says what it knows and
  // admits the rest, because a pattern nobody checked is worse than no pattern.
  //
  // Deliberately "what to name it", not "what the runner collects". The two are
  // the same on cucumber-ruby and pytest and they are *not* the same on
  // cucumber-js, which requires everything in the directory whatever it is
  // called. Stating the wider set as the rule would tell a writer that a stray
  // file is ignored, when in fact it aborts the run — so the wider set is stated
  // in `requirements`, where it can be stated as the hazard it is.
  step_files: string | null;
  // Everything else that must be true for a step file of this language to
  // execute, including what the runner does on its own and what it will do to
  // files nobody meant as steps.
  requirements: readonly string[];
}

// Load order is a fact about both Cucumbers and about neither pytest — pytest
// picks `conftest.py` up itself, so there is no trap to work around there.
const CUCUMBER_LOAD_ORDER =
  'Files load in filename order, and the shared file is not special to the runner — `account_access` ' +
  'loads before `shared`. Open each capability file with an explicit require of the shared one rather ' +
  'than trusting the alphabet.';

interface BddStrategy {
  run: (projectRoot: string, mainPath: string) => Promise<RunnerResult>;
  loading: BddStepLoading;
}

// The connector-owned BDD strategy table (spec 32): the `runner` enum names one
// of these; the connector never executes a host-provided command string. Each
// strategy runs the whole behavioral bundle and returns the raw machine-readable
// report verbatim — the connector does no marker join and no aggregation.
//
// A strategy is its command *and* its loading rule. They are one entry so that a
// fourth runner cannot be added with only half of itself stated.
const BDD_STRATEGIES: Readonly<Record<string, BddStrategy>> = {
  cucumber: {
    run: (projectRoot) => runCucumberRuby(projectRoot),
    loading: {
      step_files: '*.rb',
      requirements: [
        'The connector points `--require` at `step_definitions/`, so every `.rb` file there is loaded. ' +
          'That explicit `--require` also switches off Cucumber\'s automatic loading of `features/support/`: ' +
          'a World or helper parked there is never evaluated, and every step then fails on a bare object.',
        CUCUMBER_LOAD_ORDER,
      ],
    },
  },
  'cucumber-js': {
    run: (projectRoot) => runCucumberJs(projectRoot),
    loading: {
      step_files: '*.js',
      requirements: [
        'Keep `step_definitions/` to CommonJS JavaScript and nothing else. The connector passes the whole ' +
          'directory to `--require`, and cucumber-js `require()`s every file it matches whatever the ' +
          'extension — a stray `.ts`, `.json` or `.md` left there is executed as JavaScript and aborts the ' +
          'entire run with a parse error, before a single scenario.',
        'The connector registers no TypeScript loader, so a `.ts` file cannot compile itself. If you want ' +
          'one, register the compiler from the file that sorts first — and remember the file registering it ' +
          'is itself loaded as plain JavaScript.',
        CUCUMBER_LOAD_ORDER,
      ],
    },
  },
  'pytest-bdd': {
    run: (projectRoot, mainPath) => runPytestBdd(projectRoot, mainPath),
    loading: {
      step_files: 'test_*.py',
      requirements: [
        'pytest collects `step_definitions/` under its own default, which is `test_*.py` and `*_test.py`. ' +
          'The connector writes no `python_files` setting and will not: a file named outside those two — ' +
          '`<capability>_steps.py`, say — is simply not collected. No error, no scenarios, a green run ' +
          'over nothing.',
        '`conftest.py` is picked up by pytest itself whatever else sits beside it, so shared fixtures ' +
          'belong there and there is no load-order trap to work around.',
        'The project root is on `sys.path`, as it is for the structural branch: `from app import …` ' +
          'works in `conftest.py` and in step files, with no `sys.path` insert of your own.',
      ],
    },
  },
};

export function runBddSuite(projectRoot: string, runner: string, mainPath: string): Promise<RunnerResult> {
  const strategy = strategyFor(runner);
  if (!strategy) {
    return Promise.reject(new Error(`Unsupported BDD runner "${runner}" — rebuild the behavioral suite.`));
  }
  return strategy.run(projectRoot, mainPath);
}

// How this runner loads step files, for whoever has to write one. Null for a
// runner this connector does not run, which is the same answer `runBddSuite`
// gives it.
export function bddStepLoading(runner: string): BddStepLoading | null {
  return strategyFor(runner)?.loading ?? null;
}

// `Object.hasOwn` rather than a bare index: the runner name arrives over the
// wire, and `constructor` would otherwise come back as a truthy strategy with no
// `run` on it.
function strategyFor(runner: string): BddStrategy | null {
  return Object.hasOwn(BDD_STRATEGIES, runner) ? BDD_STRATEGIES[runner] : null;
}

// Ruby: `cucumber` with the built-in message formatter. The features and step
// definitions both live under the behavioral root; --require points at the step
// definitions so only the Unitbob bundle loads.
async function runCucumberRuby(projectRoot: string): Promise<RunnerResult> {
  const features = join(BEHAVIORAL_ROOT, 'features');
  const steps = join(BEHAVIORAL_ROOT, STEP_DEFINITIONS);
  const sidecarGemfile = join(projectRoot, BEHAVIORAL_GEMFILE);
  if (!existsSync(sidecarGemfile)) {
    throw missingRunner('Cucumber');
  }

  const command = 'bundle';
  const args = ['exec', 'cucumber', features, '--require', steps, '--format', 'message', '--out', CUCUMBER_REPORT];
  const survivor = clearReport(join(projectRoot, CUCUMBER_REPORT));

  const run = await runInProject(projectRoot, command, args, {
    timeoutMs: BDD_TIMEOUT_MS,
    env: {
      RAILS_ENV: 'test',
      UNITBOB_REPO_ROOT: projectRootAsSeenByThePlace(projectRoot),
      BUNDLE_GEMFILE: BEHAVIORAL_GEMFILE,
    },
  });

  return finalize(run, projectRoot, CUCUMBER_REPORT, survivor);
}

function missingRunner(name: string): Error {
  return new Error(
    `Behavioral runner missing (${name}). Run suite-prepare to provision it under ${BEHAVIORAL_ROOT}/, then run the checks again.`,
  );
}

// JS/TS: `@cucumber/cucumber` (cucumber-js) with the message formatter written
// to a file.
async function runCucumberJs(projectRoot: string): Promise<RunnerResult> {
  const features = join(BEHAVIORAL_ROOT, 'features');
  const steps = join(BEHAVIORAL_ROOT, STEP_DEFINITIONS, '**', '*');
  const command = `${BEHAVIORAL_ROOT}/node_modules/.bin/cucumber-js`;
  if (!executable(commandFileOnHost(projectRoot, command))) {
    throw missingRunner('Cucumber JS');
  }

  const args = [
    features,
    '--require',
    steps,
    '--format',
    `message:${CUCUMBER_REPORT}`,
  ];
  const survivor = clearReport(join(projectRoot, CUCUMBER_REPORT));

  const run = await runInProject(projectRoot, command, args, {
    timeoutMs: BDD_TIMEOUT_MS,
    env: { NODE_ENV: 'test', UNITBOB_REPO_ROOT: projectRootAsSeenByThePlace(projectRoot) },
  });

  return finalize(run, projectRoot, CUCUMBER_REPORT, survivor);
}

// Python: pytest driving pytest-bdd, with the connector's reporter plugin. The
// plugin writes the JSON report; `-c` isolates the run from the project's own
// addopts. The runner command is connector-owned.
async function runPytestBdd(projectRoot: string, mainPath: string): Promise<RunnerResult> {
  mkdirSync(join(projectRoot, BEHAVIORAL_ROOT), { recursive: true });
  writeFileSync(join(projectRoot, PYTEST_INI_FILE), PYTEST_INI);
  writeFileSync(join(projectRoot, PYTEST_BDD_PLUGIN_FILE), PYTEST_BDD_PLUGIN);

  const command = await pickPython(projectRoot);
  const stepsDir = join(BEHAVIORAL_ROOT, STEP_DEFINITIONS);
  // `python -m pytest`, as the structural branch runs it: `-m` puts the working
  // directory — the project root — on `sys.path`, so the shared conftest's
  // `from app import …` resolves. The `pytest` script does not do that, and on
  // microblog the conftest died on that import before the first Scenario, with
  // no report to read (spec 51-1).
  //
  // `--rootdir .`, not the absolute root: the working directory is the project
  // root in every place, and an absolute host path would name a directory that
  // does not exist wherever the run actually happens.
  const args = ['-m', 'pytest', '-c', PYTEST_INI_FILE, '-p', 'no:cacheprovider', '-p', pluginModule(), stepsDir, '--rootdir', '.'];
  const survivor = clearReport(join(projectRoot, PYTEST_BDD_REPORT));

  const run = await runInProject(projectRoot, command, args, {
    timeoutMs: BDD_TIMEOUT_MS,
    env: {
      UNITBOB_REPO_ROOT: projectRootAsSeenByThePlace(projectRoot),
      // Relative, and the plugin makes it absolute the moment it is imported —
      // before any fixture has had a chance to change directory. Sent as a host
      // path it would name a directory the run cannot see.
      UNITBOB_PYTEST_BDD_REPORT: PYTEST_BDD_REPORT,
      // The connector's own plugin directory, and only it. The host's own
      // PYTHONPATH used to be appended here; it names host directories, which
      // mean nothing where the run happens, and passing on the connector's
      // environment is exactly what a place must not do.
      PYTHONPATH: BEHAVIORAL_ROOT,
    },
  });

  return finalize(run, projectRoot, PYTEST_BDD_REPORT, survivor);
  // mainPath is accepted for symmetry with the structural runners; pytest-bdd
  // discovers scenarios from the step-definition modules, not the .feature path.
}

function pluginModule(): string {
  return 'unitbob_pytest_bdd_plugin';
}

function finalize(
  run: ProjectRun,
  projectRoot: string,
  reportRel: string,
  survivor: number | null,
): RunnerResult {
  return {
    ...run,
    resultPath: reportRel,
    report: readFreshReport(join(projectRoot, reportRel), survivor),
  };
}

// The sidecar's `pytest` is the sign that suite-prepare installed pytest-bdd
// there; a venv always has a `python` beside it, and that is what runs. Judging
// by `python` alone would send an unprovisioned venv into "No module named
// pytest" instead of the message that names the fix.
async function pickPython(projectRoot: string): Promise<string> {
  const sidecarVenvBin = `${BEHAVIORAL_ROOT}/.venv/bin`;
  if (executable(commandFileOnHost(projectRoot, `${sidecarVenvBin}/pytest`))) {
    return `${sidecarVenvBin}/python`;
  }
  throw missingRunner('pytest-bdd');
}
