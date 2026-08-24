import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executable, type ProcResult } from '../proc.ts';
import { BEHAVIORAL_DIR } from '../files/behavioral.ts';
import { runInProject } from './place.ts';
import {
  commandFileOnHost,
  defaultToolDeps,
  hasGemfileWith,
  projectProvidesRunner,
  runnerAvailable,
  SIDECAR_DIR,
  sidecarPath,
  type ToolDeps,
} from './toolchain.ts';

// How long a local setup step may take before we stop waiting. Provisioning a
// runner and loading a cold Rails test environment sit in the same ballpark —
// tens of seconds on a large app — so `runner/bootcheck.ts` waits on this same
// number rather than inventing a second one to keep in sync.
export const PROVISION_TIMEOUT_MS = 120_000;

// Installing an application's own dependency tree is a different order of work
// from adding one runner gem: hundreds of packages, compiled extensions, a cold
// package index. Two minutes is a normal figure for it, so it gets its own
// budget instead of borrowing one sized for a single install.
export const DEPENDENCY_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

export interface ProvisionResult {
  status: 'provisioned' | 'fixable';
  message?: string;
  checklist?: string[];
}

export interface ProvisionDeps {
  runCmd: (
    command: string,
    args: string[],
    options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
  ) => Promise<ProcResult>;
  // How "can this machine run that?" is answered. Injected for the same reason
  // `runCmd` is: a test must not pass or fail depending on whether pytest
  // happens to be installed on the machine running it.
  tools?: ToolDeps;
}

// `cwd` is the project root at every call site, and that is what decides where
// the install happens: a sidecar built by this machine is no use inside a
// container, and one built inside a container is no use here (see
// `runner/placeEnvironment.ts`).
const defaultDeps: ProvisionDeps = {
  runCmd: (command, args, options) =>
    runInProject(options.cwd, command, args, {
      timeoutMs: options.timeoutMs ?? PROVISION_TIMEOUT_MS,
      env: options.env,
    }),
};

export async function ensureRunner(
  projectRoot: string,
  runner: string,
  deps: ProvisionDeps = defaultDeps,
): Promise<ProvisionResult> {
  const behavioralDir = join(projectRoot, '.unitbob', 'behavioral');
  mkdirSync(behavioralDir, { recursive: true });

  switch (runner) {
    case 'cucumber':
      return provisionRuby(projectRoot, behavioralDir, deps);
    case 'cucumber-js':
      return provisionJs(projectRoot, behavioralDir, deps);
    case 'pytest-bdd':
      return provisionPython(projectRoot, behavioralDir, deps);
    default:
      return { status: 'fixable', message: `Unsupported BDD runner "${runner}".` };
  }
}

// Make the structural runner runnable without touching the project.
//
// Nothing is built when the project already supplies the runner itself: a
// developer with a working setup should not find a second copy of their
// toolchain appear under `.unitbob/` because they tried Unitbob once.
//
// When the project does not supply it, everything the runner needs is installed
// under `.unitbob/runners/` instead — the runner and, on the two stacks where it
// is possible, the application's own dependencies with it. The project's
// Gemfile, requirements.txt and package.json are read and never written.
//
// Python and Ruby get a complete environment this way. JavaScript deliberately
// does not: node resolves an import by walking up from the importing file, so a
// suite sitting in `.unitbob/structural/` finds the project's `node_modules` and
// can never be made to find a sidecar copy instead. Vitest itself is installed
// here because we spawn that binary by path; the project's dependencies stay the
// project's, and a missing `node_modules` comes back as a fixable notice naming
// the one command that fixes it.
export async function ensureStructuralRunner(
  projectRoot: string,
  runner: string,
  deps: ProvisionDeps = defaultDeps,
): Promise<ProvisionResult> {
  const tools = deps.tools ?? defaultToolDeps;
  if (projectProvidesRunner(projectRoot, runner, tools)) return { status: 'provisioned' };

  const dir = join(projectRoot, SIDECAR_DIR);
  mkdirSync(dir, { recursive: true });

  switch (runner) {
    case 'pytest':
      return provisionPytest(projectRoot, deps);
    case 'vitest':
      return provisionVitest(projectRoot, deps);
    case 'rspec':
      return provisionRspec(projectRoot, deps);
    default:
      return { status: 'fixable', message: `Unsupported structural runner "${runner}".` };
  }
}

// The builders we can make an environment with, in the order we try them.
//
// `python3 -m venv` before `uv` even though uv is faster: the standard-library
// builder always puts pip in the environment it makes, and `uv venv`
// deliberately does not. An environment with no pip is one nothing can be
// installed into afterwards.
//
// And no `--system-site-packages`. Borrowing the machine's own packages looks
// like a saving — the application's dependencies may already be installed
// globally — but it makes the environment a different one on every machine,
// which is the one thing a sidecar exists to prevent. It also lets pytest pick
// up plugins nobody asked for: measured on a Flask app where an unrelated
// globally-installed langsmith plugin was loaded into the run and died on a
// pydantic/typing_extensions mismatch, so a project that imports perfectly well
// could not be collected. This environment holds the requirements file and
// pytest, and nothing else. Found 2026-08-12.
const VENV_BUILDERS = [
  { command: 'python3', args: (venvDir: string) => ['-m', 'venv', venvDir] },
  { command: 'python', args: (venvDir: string) => ['-m', 'venv', venvDir] },
  { command: 'uv', args: (venvDir: string) => ['venv', venvDir] },
];

// A virtual environment under `.unitbob/runners/.venv` holding pytest and, when
// the project declares them in a requirements file, the application's own
// packages — and deliberately nothing else. See `VENV_BUILDERS`.
async function provisionPytest(projectRoot: string, deps: ProvisionDeps): Promise<ProvisionResult> {
  const venvDir = `${SIDECAR_DIR}/.venv`;
  const venvPython = `${venvDir}/bin/python`;

  const built = await buildPythonEnvironment(projectRoot, venvDir, deps);
  if (!built.created) {
    return {
      status: 'fixable',
      message: `Failed to create a virtual environment under ${SIDECAR_DIR}/.venv.`,
      checklist: ['Install python3-venv or uv: `python3 -m venv --help`, or `pip install uv`.'],
    };
  }

  const pytest = await pipInstall(deps, projectRoot, venvPython, ['pytest']);
  const notes = built.requirementsNote ? [built.requirementsNote] : [];

  if (pytest.ok || runnerAvailable(projectRoot, 'pytest', deps.tools ?? defaultToolDeps)) {
    return notes.length > 0 ? { status: 'provisioned', checklist: notes } : { status: 'provisioned' };
  }

  return {
    status: 'fixable',
    message: `Failed to install pytest into ${SIDECAR_DIR}/.venv.`,
    checklist: [`Run \`${venvPython} -m pip install pytest\` manually to provision the runner.`, ...notes],
  };
}

// Build a Python environment holding the application's declared dependencies,
// and say so honestly when they would not go in. Both branches call it: the
// structural suite imports the application and the behavioral suite drives it,
// so neither is any use in an environment the application is not installed in.
//
// An interpreter that is merely present is not one the project can run on. A
// machine can easily carry a Python newer than everything the project pins —
// measured on a Flask app whose psycopg2, greenlet and multidict have no wheels
// for 3.14 and do not compile against it, while the 3.11 standing beside it
// installs all three from wheels in seconds. So when the requirements will not
// go in, the environment is rebuilt with the next builder rather than handed
// over half-empty. Found 2026-08-12.
// `venvDir` is relative to the project root, like every other path that reaches
// a command: the interpreter is built and then started by the place, and only
// the existence checks below are the host's (spec 36, §4.2).
async function buildPythonEnvironment(
  projectRoot: string,
  venvDir: string,
  deps: ProvisionDeps,
): Promise<{ created: boolean; requirementsNote?: string }> {
  const venvPython = `${venvDir}/bin/python`;

  // The project's own statement of what it needs. It is also the only test of
  // whether an environment is any use: one the application's packages will not
  // install into is the wrong environment, however well it was built.
  const requirements = ['requirements.txt', 'requirements/base.txt', 'requirements-dev.txt']
    .find((name) => existsSync(join(projectRoot, name)));

  let created = existsSync(join(projectRoot, venvPython));
  let requirementsOk = requirements === undefined;
  let failure: string | undefined;

  for (const [index, builder] of VENV_BUILDERS.entries()) {
    if (!created) {
      const result = await deps
        .runCmd(builder.command, builder.args(venvDir), { cwd: projectRoot })
        .catch(() => ({ code: 1, stdout: '', stderr: '' }));
      if (result.code !== 0) continue;
      created = true;
    }

    if (requirements === undefined) break;

    const installed = await pipInstall(deps, projectRoot, venvPython, ['-r', requirements]);
    if (installed.ok) {
      requirementsOk = true;
      break;
    }

    // Keep the first complaint: it comes from the interpreter the project would
    // have been given by default, and it is the one worth reporting if no
    // interpreter here works.
    failure ??= installed.detail ?? '';

    // Discard the environment only while there is another builder to try. The
    // last one is kept even though the requirements did not go in: the runner
    // still installs into it, and a suite that runs and cannot import the
    // application says far more than no suite at all.
    if (index === VENV_BUILDERS.length - 1) break;
    rmSync(join(projectRoot, venvDir), { recursive: true, force: true });
    created = false;
  }

  if (!created) return { created };
  if (requirements === undefined) {
    return { created, requirementsNote: noDependencySourceNote(projectRoot, venvDir) };
  }
  if (requirementsOk) return { created };

  // The reason travels with the notice. Without it the reader is told that
  // something did not install and has to re-run the install by hand to find out
  // what — and the answer is usually one line ("no wheel for this Python",
  // "pg_config not found") that decides what they do next.
  return {
    created,
    requirementsNote:
      `installing ${requirements} into ${venvDir} did not finish on any Python ` +
      `available here — the suite may not be able to import the application.` +
      (failure ? ` The install said: ${failure}` : ''),
  };
}

// A Python project that states its dependencies somewhere other than a
// requirements file was the quietest failure in here: nothing found to install
// was read as nothing to install, the environment was declared a success, and
// the suite then met the application it could not import. Detection accepts
// `pyproject.toml` and `Pipfile` (see `precheck.ts`) while this function only
// ever read `requirements*.txt`, so the two disagreed about what a Python
// project is.
//
// Installing from those two sources is not attempted here yet. Saying so is not
// optional: "we did not install your application's packages, and here is why"
// is a sentence the reader can act on, and an empty environment reported as
// built is not.
function noDependencySourceNote(projectRoot: string, venvDir: string): string {
  const declared = ['pyproject.toml', 'Pipfile'].filter((name) => existsSync(join(projectRoot, name)));
  const where = declared.length
    ? `this project declares its dependencies in ${declared.join(' and ')}, which Unitbob does not install from yet`
    : 'no requirements.txt, pyproject.toml or Pipfile was found';

  return (
    `the application's own packages are not installed into ${venvDir} — ${where}. ` +
    'The suite can start, but it may not be able to import the application.'
  );
}

// Install into the sidecar environment, whichever tool built it.
//
// `python -m pip` rather than the `bin/pip` script: the script is missing from a
// uv-built environment, and calling a path that is not there throws ENOENT,
// which reads as "the install failed" when nothing was ever attempted. `uv pip`
// is the second attempt for exactly that environment.
async function pipInstall(
  deps: ProvisionDeps,
  projectRoot: string,
  venvPython: string,
  packages: string[],
): Promise<{ ok: boolean; detail?: string }> {
  let last: ProcResult | undefined;
  for (const candidate of [
    { command: venvPython, args: ['-m', 'pip', 'install', ...packages] },
    { command: 'uv', args: ['pip', 'install', '--python', venvPython, ...packages] },
  ]) {
    last = await deps
      .runCmd(candidate.command, candidate.args, { cwd: projectRoot, timeoutMs: DEPENDENCY_INSTALL_TIMEOUT_MS })
      .catch(() => ({ code: 1, stdout: '', stderr: '' }));
    if (last.code === 0) return { ok: true };
  }
  return { ok: false, detail: last ? installerComplaint(last) : undefined };
}

// The one line of an installer's output that says what went wrong. pip prints
// hundreds of lines of compiler noise and, among the lines that do look like
// errors, one is a verbatim dump of the compiler command — three hundred
// characters of flags whose only readable part is the word "clang". That line
// is dropped along with anything else too long to be a summary, which leaves
// pip's own verdict ("Failed building wheel for psycopg2-binary").
function installerComplaint(result: ProcResult): string | undefined {
  const complaints = `${result.stdout}\n${result.stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(error|ERROR|×|note: This error|Failed to build)/.test(line))
    .filter((line) => line.length <= 160 && !line.includes("Command '["));

  return complaints[complaints.length - 1];
}

// Vitest under `.unitbob/runners/node_modules`, spawned by path. See the note on
// `ensureStructuralRunner` for why the application's own packages are not
// installed here.
async function provisionVitest(projectRoot: string, deps: ProvisionDeps): Promise<ProvisionResult> {
  writeIfChanged(
    sidecarPath(projectRoot, 'package.json'),
    JSON.stringify({ name: 'unitbob-structural-sidecar', private: true, devDependencies: { vitest: '^3.0.0' } }, null, 2) + '\n',
  );

  if (!runnerAvailable(projectRoot, 'vitest')) {
    const installed = await firstSuccess(deps, projectRoot, [
      { command: 'npm', args: ['install', '--prefix', SIDECAR_DIR] },
      { command: 'pnpm', args: ['install', '--prefix', SIDECAR_DIR] },
      { command: 'yarn', args: ['install', '--cwd', SIDECAR_DIR] },
    ], DEPENDENCY_INSTALL_TIMEOUT_MS);

    if (!installed && !runnerAvailable(projectRoot, 'vitest')) {
      return {
        status: 'fixable',
        message: `Failed to install vitest into ${SIDECAR_DIR}.`,
        checklist: [`Install it manually: \`npm install --prefix ${SIDECAR_DIR}\`.`],
      };
    }
  }

  // The suite imports the application, and on this stack that resolves through
  // the project's own node_modules — the one thing a sidecar cannot stand in for.
  if (existsSync(join(projectRoot, 'package.json')) && !existsSync(join(projectRoot, 'node_modules'))) {
    return {
      status: 'provisioned',
      checklist: [
        "This project's own dependencies are not installed (`node_modules` is missing), and on this stack " +
          'they cannot be installed under `.unitbob/` — node resolves imports from the project itself. ' +
          'Run `npm install` in the project before generating, or the suite will not be able to import it.',
      ],
    };
  }

  return { status: 'provisioned' };
}

// Frozen bundler, turned off for our own Gemfile and for nothing else
// (spec 36, task 2.6).
//
// The sidecar Gemfile adds a gem the project's lockfile has never heard of —
// that is its entire job — and under `frozen` or `deployment` bundler refuses
// exactly that: "the dependencies in your gemfile changed, but the lockfile
// can't be updated because frozen mode is set". Nothing installs, and the
// vibecoder is told to commit a file the connector wrote.
//
// Measured, not reasoned about (2026-08-17, `ruby:3.3-slim`). The project's own
// `.bundle/config` does *not* reach here: bundler reads app config relative to
// the Gemfile it was given, which is `.unitbob/runners/`. The environment does,
// and a dev or production image setting `BUNDLE_DEPLOYMENT=1` is ordinary. So
// the override is scoped to the one install whose Gemfile we wrote; the
// project's own bundler settings are never touched, and no other bundler
// invocation carries this.
const UNFROZEN_SIDECAR = { BUNDLE_FROZEN: 'false', BUNDLE_DEPLOYMENT: 'false' };

// One gem line for the sidecar, asked for only if the project has not asked for
// it already.
//
// `eval_gemfile` runs the project's own Gemfile inside *this* Dsl object — that
// is the whole point of it, and it is also the trap. Every `gem` line we add
// afterwards lands in the same dependency list the project just filled, so a gem
// the project already names is declared twice, and bundler's rules for that are
// strict: identical requirements warn, differing ones raise `GemfileError` while
// the Gemfile is still being parsed.
//
// Measured on bundler 2.4.22 and 4.0.1 after A2.Time (Rails 5.0, Ruby 2.7.8)
// could not generate a behavioral suite at all, 2026-08-20. It pins
// `webmock "~> 3.23"`; we asked for `webmock (>= 0)`:
//
//   You cannot specify the same gem twice with different version requirements.
//   You specified: webmock (~> 3.23) and webmock (>= 0). Bundler cannot continue.
//
// Parsing fails before resolution begins, so there is no lock and no versions to
// negotiate — and `suite-prepare` rewrote the same conflicting file on every
// retry, which left the vibecoder with nothing to patch either. The comment that
// used to sit on the webmock line had this exactly backwards: it promised the
// project's own version would win "because bundler starts from the project's own
// resolution". True of resolution. Parsing never reached it.
//
// `dependencies` is Bundler::Dsl's own reader and the Gemfile is instance_eval'd
// on the Dsl, so the list is in scope and already holds everything the project
// declared. Checked in the dsl.rb of 2.1.4, 2.2.33, 2.3.27, 2.4.22 and 4.0.1 —
// 2.1.4 because it is what Ruby 2.7.8 ships, and Ruby 2.7.8 is what the
// application that found this bug runs.
//
// What we would have added is dropped rather than merged, version and all: a
// project pinning `cucumber "~> 8.0"` gets a sidecar on cucumber 8 instead of a
// hard failure. The suite then runs on the version that project already trusts,
// which is the bargain the rest of this sidecar strikes anyway — it inherits the
// project's Gemfile precisely so the two cannot drift apart.
//
// One thing this does give up, measured on 2.1.4 and 4.0.1 rather than assumed.
// Where the requirements happened to match, bundler used to keep *both*
// declarations — the project's and ours — so a gem the project had confined to
// `group :test` also arrived ungrouped through us, and no `BUNDLE_WITHOUT` could
// drop it. Skipping our line leaves only the project's, groups and all. That is
// the honest arrangement, and it is not silent: the World probe of spec 35-1
// asserts against a live `WebMock::NetConnectNotAllowedError`, so a webmock that
// did not come along stops `suite-prepare` with a fixable probe failure instead
// of letting a suite run with the block it advertises quietly missing.
function gemLineUnlessTheProjectHasIt(name: string, requirement?: string): string {
  const pin = requirement ? `, "${requirement}"` : '';
  return `gem "${name}"${pin}, require: false unless dependencies.any? { |d| d.name == "${name}" }\n`;
}

const BUNDLER_OUTPUT_LINES = 20;
const BUNDLER_OUTPUT_CHARS = 2000;

// What bundler said, kept instead of thrown away. Reads as the sentence after
// "Bundler failed to ...", whichever of its three shapes it takes.
//
// Both Ruby sidecars used to capture `result` and then return a fixed line, so a
// provisioning failure reached the vibecoder as "Bundler failed to provision ..."
// and nothing else. On A2.Time that hid the `GemfileError` above completely: the
// run reported a blocked behavioral branch, the reason was already in this
// process's memory, and it still took a round trip through the user — run bundler
// by hand, paste the output — to find out what it was. An error we have been told
// is not one to make somebody fetch again.
//
// The tail, because bundler puts the reason last on failures long enough to
// scroll (a resolution conflict prints its whole search first), and a Gemfile
// that will not parse is short enough that the tail is all of it. Not
// `installerComplaint`, which is next door and does the opposite on purpose: it
// picks the single line pip labelled an error out of hundreds of lines of
// compiler noise. Bundler's verdict carries no such label — the one that matters
// here opens with `[!]` and runs over three lines — so filtering by line would
// drop exactly the sentence worth keeping.
function whatBundlerSaid(result: ProcResult): string {
  const text = [result.stdout, result.stderr].map((part) => part.trim()).filter(Boolean).join('\n');
  // A null code is a process this connector killed, not one that decided
  // anything. No number is named with it: the two callers run under different
  // budgets — `provisionRspec` asks for `DEPENDENCY_INSTALL_TIMEOUT_MS`,
  // `provisionRuby` takes the `PROVISION_TIMEOUT_MS` default — and a message
  // that states the wrong one is worse than a message that states none.
  if (!text) {
    return result.code === null
      ? 'It said nothing: it was stopped before it could, having run past its timeout or lost the place it was running in.'
      : `It said nothing, and exited ${result.code}.`;
  }
  const lines = text.split('\n');
  const tail = lines.slice(-BUNDLER_OUTPUT_LINES).join('\n').slice(-BUNDLER_OUTPUT_CHARS);
  return `It said:\n${tail.length < text.length ? `...\n${tail}` : tail}`;
}

// A sidecar Gemfile that inherits the project's own, plus rspec-rails. Bundler
// resolves the two together, so the application's gems come with it — the same
// arrangement the Cucumber sidecar has used since spec 32-1, and the reason the
// project's Gemfile is read rather than edited.
async function provisionRspec(projectRoot: string, deps: ProvisionDeps): Promise<ProvisionResult> {
  const sidecarGemfile = sidecarPath(projectRoot, 'Gemfile');
  writeIfChanged(
    sidecarGemfile,
    '# Sidecar Gemfile written by the unitbob connector — do not edit.\n' +
      'eval_gemfile File.expand_path("../../../Gemfile", __FILE__)\n' +
      // Deliberately *not* guarded the way the Cucumber sidecar below is.
      // `ensureStructuralRunner` only reaches here when the project does not
      // supply rspec itself, so the duplicate that stopped A2.Time has almost no
      // way in — and the guard would cost something real where it does. Measured
      // 2026-08-20 on a gem project that carries rspec-rails as a gemspec
      // development dependency: bundler replaces a `:development` dependency with
      // ours rather than refusing it, so today the runner lands in `:default` and
      // is always installed. Guarded, we would skip our line and leave it in
      // `:development`, where a `BUNDLE_WITHOUT=development` would take the
      // structural runner away from a project that had it working.
      //
      // That leaves one narrow hole: rspec-rails reached through an eval'd
      // sub-Gemfile does raise the duplicate error here. It is now a legible one
      // — see the message below, which no longer swallows what bundler said.
      'gem "rspec-rails", require: false\n',
  );

  // Start from the project's own resolution for the reason spelled out on the
  // Cucumber sidecar below: without it bundler re-resolves the whole graph and
  // hands the sidecar versions the project does not run.
  copyLockIfPresent(projectRoot, sidecarPath(projectRoot, 'Gemfile.lock'));

  const command = executable(join(projectRoot, 'bin', 'bundle')) ? 'bin/bundle' : 'bundle';
  const result = await deps
    .runCmd(command, ['install'], {
      cwd: projectRoot,
      env: { BUNDLE_GEMFILE: `${SIDECAR_DIR}/Gemfile`, ...UNFROZEN_SIDECAR },
      timeoutMs: DEPENDENCY_INSTALL_TIMEOUT_MS,
    })
    .catch((err) => ({ code: 1, stdout: '', stderr: String(err) }));

  if (result.code === 0) return { status: 'provisioned' };

  return {
    status: 'fixable',
    message: `Bundler failed to provision rspec-rails under ${SIDECAR_DIR}. ${whatBundlerSaid(result)}`,
    checklist: [
      'Ensure bundler is installed (`gem install bundler`), then run ' +
        `\`BUNDLE_GEMFILE=${SIDECAR_DIR}/Gemfile bundle install\` from the project root.`,
    ],
  };
}

// Run each candidate until one exits zero. Used for the "uv, else venv" and
// "npm, else pnpm, else yarn" ladders, which are the same shape.
async function firstSuccess(
  deps: ProvisionDeps,
  cwd: string,
  candidates: { command: string; args: string[] }[],
  timeoutMs?: number,
): Promise<boolean> {
  for (const candidate of candidates) {
    const result = await deps
      .runCmd(candidate.command, candidate.args, { cwd, timeoutMs })
      .catch(() => ({ code: 1, stdout: '', stderr: '' }));
    if (result.code === 0) return true;
  }
  return false;
}

function writeIfChanged(path: string, content: string): void {
  if (!existsSync(path) || readFileSync(path, 'utf8') !== content) writeFileSync(path, content);
}

function copyLockIfPresent(projectRoot: string, destination: string): void {
  const projectLock = join(projectRoot, 'Gemfile.lock');
  if (existsSync(projectLock)) writeFileSync(destination, readFileSync(projectLock, 'utf8'));
}

// The pin the sidecar asks for, and the oldest Ruby that pin will install on.
// Written next to each other because they are one fact: every cucumber in the
// 9.x line declares `required_ruby_version >= 2.7` (checked against rubygems for
// 9.0.0 through 9.2.1, 2026-08-24). Move the pin and this number moves with it.
const CUCUMBER_PIN = '~> 9.0';
const CUCUMBER_MIN_RUBY = { major: 2, minor: 7, text: '2.7' };

// Spec 37-2, criterion 4. One known refusal, made legible — not a parser for
// other people's error messages.
//
// a2time, 2026-08-17: the behavioral branch came back "Bundler failed to
// provision Cucumber sidecar gem", and the cause was a fact this process could
// have read in one command — the host's Ruby is 2.6.10, older than the cucumber
// this connector pins. It cost a round trip through the vibecoder to run
// `bundle install` by hand and read the same sentence back.
//
// Asked before the install rather than after: `bundle install` on a cold
// application takes minutes, and the answer is the same either way.
//
// Only when our pin is the one that applies. A project that declares cucumber
// itself keeps its own version — `gemLineUnlessTheProjectHasIt` drops our line
// whole — and refusing that project over a floor it never had to meet would
// stop a build that works.
//
// The Gemfile is read as text, while the line that drops the pin asks bundler's
// own resolved `dependencies`. The two can disagree, and only one direction of
// disagreement is expensive: a project whose cucumber arrives through `gemspec`
// or an `eval_gemfile` would be refused over a floor it never had to meet. So
// those two words count as "the project may name it", and the check stays quiet
// — back to bundler's own message, which is where this started and no worse.
const PROJECT_MAY_NAME_CUCUMBER = /^\s*gem\s+["']cucumber["']|^\s*gemspec\b|^\s*eval_gemfile\b/m;

async function rubyTooOldForCucumber(projectRoot: string, deps: ProvisionDeps): Promise<string | null> {
  if (hasGemfileWith(projectRoot, PROJECT_MAY_NAME_CUCUMBER)) return null;

  const result = await deps
    .runCmd('ruby', ['-v'], { cwd: projectRoot })
    .catch(() => ({ code: 1, stdout: '', stderr: '' }));
  if (result.code !== 0) return null;

  // A version we cannot read stops nothing. This check exists to replace one
  // confusing message with one clear one, and guessing here would replace a
  // clear failure with a wrong refusal.
  const found = `${result.stdout}\n${result.stderr}`.match(/\bruby (\d+)\.(\d+)\.(\d+)/i);
  if (!found) return null;

  const [, major, minor] = found;
  const older = Number(major) < CUCUMBER_MIN_RUBY.major
    || (Number(major) === CUCUMBER_MIN_RUBY.major && Number(minor) < CUCUMBER_MIN_RUBY.minor);
  return older ? `${major}.${minor}.${found[3]}` : null;
}

async function provisionRuby(
  projectRoot: string,
  behavioralDir: string,
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  const oldRuby = await rubyTooOldForCucumber(projectRoot, deps);
  if (oldRuby) {
    return {
      status: 'fixable',
      message:
        `Cucumber ${CUCUMBER_PIN} needs Ruby ${CUCUMBER_MIN_RUBY.text} or newer, and the Ruby answering here is ` +
        `${oldRuby}. Bundler was not asked to install it.`,
      checklist: [
        `Run Unitbob where the application runs. The Ruby that answered is ${oldRuby}; if the app itself runs ` +
          'on a newer one inside a container, name that container under `exec` in `.unitbob.json` and this ' +
          'check runs there instead.',
        `Or declare \`cucumber\` in the project's own Gemfile at a version that supports Ruby ${oldRuby} — ` +
          'the sidecar drops its own pin whenever the project names the gem.',
      ],
    };
  }

  const sidecarGemfile = join(behavioralDir, 'Gemfile');
  const sidecarContent =
    '# Sidecar Gemfile generated by Unitbob (Spec 32-1)\n' +
    'eval_gemfile File.expand_path("../../../Gemfile", __FILE__)\n' +
    gemLineUnlessTheProjectHasIt('cucumber', CUCUMBER_PIN) +
    // The connector-owned World blocks outgoing HTTP (spec 35-1), and it can only
    // do that if webmock resolves here. A project that does not carry the gem
    // would otherwise get a World promising a block it silently never performs —
    // the exact shape of failure 35-1 closes. A project that does carry it keeps
    // its own version, and now actually gets to: see the comment on the helper
    // for what asking twice cost A2.Time.
    gemLineUnlessTheProjectHasIt('webmock');

  if (!existsSync(sidecarGemfile) || readFileSync(sidecarGemfile, 'utf8') !== sidecarContent) {
    writeFileSync(sidecarGemfile, sidecarContent);
  }

  // Start the sidecar from the project's own resolution, so bundler adds
  // cucumber and leaves everything else on the versions the project already
  // runs. Without a starting lock it resolves the whole graph from scratch: on
  // a2time that moved 285 gems, handed the sidecar carrierwave 2.2.0 where the
  // project pins 2.2.6, and Rails then would not load at all (`cannot load such
  // file -- mimemagic/overlay`). The behavioral branch could not start, and the
  // boot check of 32-6 had said `ok` — truthfully, because it only ever asks the
  // structural runner. Found on the a2time run 2026-08-04.
  //
  // Copied on every provision rather than only when missing. A lock seeded once
  // goes stale the moment the project upgrades a gem — the sidecar Gemfile
  // inherits the project's *Gemfile* through `eval_gemfile`, never its lock, so
  // nothing would pull the new version through and the drift this exists to
  // prevent comes back slowly instead of at once. `bundle install` already runs
  // on every provision, so re-adding cucumber to a fresh copy costs nothing new.
  const projectLock = join(projectRoot, 'Gemfile.lock');
  if (existsSync(projectLock)) {
    writeFileSync(join(behavioralDir, 'Gemfile.lock'), readFileSync(projectLock, 'utf8'));
  }

  // The Cucumber sidecar has the same shape and the same problem as the rspec
  // one: it adds gems the project's lockfile does not carry. See UNFROZEN_SIDECAR.
  const gemfileRel = `${BEHAVIORAL_DIR}/Gemfile`;
  const env = { BUNDLE_GEMFILE: gemfileRel, ...UNFROZEN_SIDECAR };

  // Try project local bin/bundle, then bundle. Relative with a slash: the
  // working directory is the project root, and a bare name would be looked up on
  // PATH instead.
  const cmd = executable(join(projectRoot, 'bin', 'bundle')) ? 'bin/bundle' : 'bundle';
  const result = await deps.runCmd(cmd, ['install'], { cwd: projectRoot, env }).catch((err) => ({
    code: 1,
    stdout: '',
    stderr: String(err),
  }));

  if (result.code === 0) {
    return { status: 'provisioned' };
  }

  return {
    status: 'fixable',
    message: `Bundler failed to provision Cucumber sidecar gem. ${whatBundlerSaid(result)}`,
    checklist: ['Ensure bundler is installed (`gem install bundler`) and run `bundle install` manually inside `.unitbob/behavioral/`.'],
  };
}

async function provisionPython(
  projectRoot: string,
  behavioralDir: string,
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  // Two forms of one path, and the split is the rule of spec 36, §4.2: what a
  // command names is relative, because the command runs where the dependencies
  // live; what we test for existence is the host's, because that is where the
  // files are.
  const venvDir = `${BEHAVIORAL_DIR}/.venv`;
  const venvPython = `${venvDir}/bin/python`;
  const venvPytest = commandFileOnHost(projectRoot, `${venvDir}/bin/pytest`);

  // The behavioral suite drives the application, so its environment needs the
  // application in it — the same requirement, and now the same treatment, as the
  // structural peer. It used to be built with `--system-site-packages` and given
  // nothing but pytest-bdd, on the assumption that the machine already had the
  // project's packages. On a machine that did not, every scenario failed on
  // `No module named flask` in an environment Unitbob had just built for it.
  const built = await buildPythonEnvironment(projectRoot, venvDir, deps);
  if (!built.created) {
    return {
      status: 'fixable',
      message: `Failed to create virtual environment under ${venvDir}.`,
      checklist: ['Install python3-venv or uv: `python3 -m venv --help` or `pip install uv`.'],
    };
  }

  const installed = existsSync(venvPytest) || (await pipInstall(deps, projectRoot, venvPython, ['pytest-bdd'])).ok;
  if (!installed && !existsSync(venvPytest)) {
    return {
      status: 'fixable',
      message: `Failed to install pytest-bdd into ${venvDir}.`,
      checklist: [`Run \`${venvPython} -m pip install pytest-bdd\` manually to provision the runner.`],
    };
  }

  return built.requirementsNote
    ? { status: 'provisioned', checklist: [built.requirementsNote] }
    : { status: 'provisioned' };
}

async function provisionJs(
  projectRoot: string,
  behavioralDir: string,
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  const sidecarPkg = join(behavioralDir, 'package.json');
  const sidecarContent = JSON.stringify(
    {
      name: 'unitbob-behavioral-sidecar',
      private: true,
      devDependencies: {
        '@cucumber/cucumber': '^10.0.0',
        'ts-node': '^10.9.0',
      },
    },
    null,
    2,
  ) + '\n';

  if (!existsSync(sidecarPkg) || readFileSync(sidecarPkg, 'utf8') !== sidecarContent) {
    writeFileSync(sidecarPkg, sidecarContent);
  }

  const cucumberBin = join(behavioralDir, 'node_modules', '.bin', 'cucumber-js');
  if (existsSync(cucumberBin)) {
    return { status: 'provisioned' };
  }

  // Fallback ladder: npm -> pnpm -> yarn
  const managers = [
    { cmd: 'npm', args: ['install', '--prefix', '.unitbob/behavioral'] },
    { cmd: 'pnpm', args: ['install', '--prefix', '.unitbob/behavioral'] },
    { cmd: 'yarn', args: ['install', '--cwd', '.unitbob/behavioral'] },
  ];

  for (const mgr of managers) {
    const res = await deps.runCmd(mgr.cmd, mgr.args, { cwd: projectRoot }).catch(() => ({ code: 1 }));
    if (res.code === 0 || existsSync(cucumberBin)) {
      return { status: 'provisioned' };
    }
  }

  return {
    status: 'fixable',
    message: 'Failed to install @cucumber/cucumber sidecar dependency.',
    checklist: ['Install dependencies manually: `npm install --prefix .unitbob/behavioral`.'],
  };
}
