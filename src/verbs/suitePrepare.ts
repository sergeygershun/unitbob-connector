import type { Config } from '../config.ts';
import { clearRunState } from '../runner/failureDigest.ts';
import { materializeHelper } from '../files/guardrails.ts';
import { materializeBehavioralWorld } from '../files/behavioral.ts';
import { PACKETS_DIR, writeSuitePackets, type SuitePacketsSummary } from '../files/packets.ts';
import {
  recipeNameFor,
  writeSuiteBuildRequest,
  type KnownDefectContext,
  type SuiteBuildBranch,
  type SuiteBuildRequest,
} from '../files/suiteBuild.ts';
import { bddStepLoading, type BddStepLoading } from '../runner/bdd.ts';
import { bootCheck, SIGNAL_STRENGTH, type BootCheck } from '../runner/bootcheck.ts';
import {
  anyStackPrecheck,
  behavioralHarnessNotice,
  detectBddRunner,
  detectStructuralRunner,
  runnerReadyPrecheck,
} from '../runner/precheck.ts';
import { selectRunnerEnvelope, withInstalledRunnerVersion, type RunnerEnvelope } from '../runner/manifest.ts';
import { placeProblem } from '../runner/place.ts';
import { alignRunnerEnvironmentWithPlace } from '../runner/placeEnvironment.ts';
import { ensureRunner, ensureStructuralRunner, type ProvisionResult } from '../runner/provision.ts';
import { ToolchainUnavailableError } from '../runner/toolchain.ts';
import { probeBehavioralWorld, type WorldProbeResult } from '../runner/worldProbe.ts';
import { Wire, type Recipe, type SuitePacket } from '../wire.ts';

interface SuitePrepareDeps {
  getRecipe: (name: string) => Promise<Recipe>;
  getSuitePacketsBatch: () => Promise<SuitePacket[]>;
  precheck: (projectRoot: string) => { ok: boolean; message?: string; runner?: string };
  confirmRunner: (projectRoot: string, runner: string) => { ok: boolean; message?: string };
  bootCheck: (projectRoot: string, runner: string | null) => Promise<BootCheck>;
  ensureRunner: (projectRoot: string, runner: string) => Promise<ProvisionResult>;
  ensureStructuralRunner: (projectRoot: string, runner: string) => Promise<ProvisionResult>;
  worldProbe: (projectRoot: string) => Promise<WorldProbeResult>;
  runnerEnvelope: (packet: SuitePacket, runner: string | undefined, projectRoot: string) => RunnerEnvelope | null;
  stdout: { write: (chunk: string) => unknown };
}

// The complete envelope for one branch, or null when this machine cannot
// produce one: the server offered no combination this stack matches, or the
// behavioral runner's installed version could not be read back.
//
// Null stops the branch rather than handing the host a shape to fill in. The
// host's own composition is what this path replaced — a single wrong field is
// rejected at upload, hours after the suite was written, run, and reviewed —
// and a half-filled envelope fails the same way. Better to say so now, in one
// line, than to be told by the server at the end.
// Why a branch got no envelope, in the vibecoder's terms. The two causes sit on
// opposite sides of the wire and have opposite fixes, so they are never merged
// into one vague line.
function envelopeBlockedReason(packet: SuitePacket, runner: string | undefined): string {
  if (!Array.isArray(packet.runner_manifests) || packet.runner_manifests.length === 0) {
    return 'the Unitbob server sent no runner combinations with this assignment — it is older than this connector. ' +
      'Update the server (or the connector) so the two agree, then retry.';
  }
  if (!runner) {
    return `this project matches none of the runners the server offered for the ${packet.suite_kind} suite.`;
  }
  return `the version of "${runner}" installed under .unitbob/behavioral/ could not be read, and the server requires it. ` +
    'Re-run `unitbob suite-prepare` so the runner is provisioned again.';
}

function runnerEnvelopeFor(
  packet: SuitePacket,
  runner: string | undefined,
  projectRoot: string,
): RunnerEnvelope | null {
  const selected = runner
    ?? (packet.suite_kind === 'behavioral'
      ? detectBddRunner(projectRoot) ?? undefined
      : detectStructuralRunner(projectRoot) ?? undefined);
  const envelope = selectRunnerEnvelope(packet.runner_manifests, selected);
  if (!envelope || !selected) return envelope;

  // Only the behavioral runner is provisioned into an isolated environment, so
  // it is the only one with an installed version to record.
  return packet.suite_kind === 'behavioral'
    ? withInstalledRunnerVersion(envelope, selected, projectRoot)
    : envelope;
}

// Confirm at least one supported stack is present, materialize the Ruby boot
// helper an RSpec suite would need — only in a Ruby project — then fetch both
// peer assignments
// (spec 32) and each branch's recipe, and write the host's task to
// `.unitbob/suite-build/request.json`. No model is called and no source is read
// here — that is the host's job, framed by the two generation recipes. An
// unsupported project stops with one actionable message and writes nothing; a
// no-current-map error from the server surfaces (via WireError) with guidance to
// rebuild the map first.
export async function suitePrepare(config: Config, args: string[] = [], deps?: Partial<SuitePrepareDeps>): Promise<void> {
  const defectContext = knownDefectContext(args);
  const wire = new Wire(config);
  const actual: SuitePrepareDeps = {
    getRecipe: (name) => wire.getRecipe(name),
    getSuitePacketsBatch: () => wire.getSuitePacketsBatch(),
    precheck: anyStackPrecheck,
    confirmRunner: (projectRoot, runner) => runnerReadyPrecheck(projectRoot, runner),
    bootCheck: (projectRoot, runner) => bootCheck(projectRoot, runner),
    ensureRunner: deps?.ensureRunner ?? ensureRunner,
    ensureStructuralRunner: deps?.ensureStructuralRunner ?? ensureStructuralRunner,
    worldProbe: deps?.worldProbe ?? probeBehavioralWorld,
    runnerEnvelope: runnerEnvelopeFor,
    stdout: process.stdout,
    ...deps,
  };

  // Spec 36, criterion 7. Before the first byte is written and long before the
  // first call to the server: a place that cannot be used is a fact we can learn
  // now, and learning it after a suite has been generated and run means the
  // evidence disappeared with the container.
  //
  // Not a `ToolchainUnavailableError`: the place is named in the config and the
  // message below already says what to do about it. Suggesting a container to
  // somebody whose container is the problem is noise.
  const unusable = placeProblem(config.projectRoot);
  if (unusable) throw new Error(`${unusable}\nNothing was written and nothing was uploaded.`);

  const check = actual.precheck(config.projectRoot);
  // Deliberately a plain stop. This one says "none of the three stacks is here",
  // which is read off files — a Gemfile, a package.json, a requirements.txt —
  // and those are on this machine whatever place the run happens in. A container
  // is never the answer to it.
  if (!check.ok) throw new Error(check.message ?? 'Unsupported runtime.');

  // An environment installed somewhere else is not an environment (spec 36, §6).
  // Here, where it can be built again, and before anything asks whether a runner
  // is ready.
  const replaced = alignRunnerEnvironmentWithPlace(config.projectRoot);
  if (replaced) actual.stdout.write(`${replaced}\n`);

  // Ruby only. This wrote `unitbob_helper.rb` and `rspec.opts` into every
  // project it touched, so a Flask app and a NestJS app each came away with a
  // Ruby file they never asked for and cannot run — the product leaving another
  // stack's litter in someone's repository.
  if (detectStructuralRunner(config.projectRoot) === 'rspec') materializeHelper(config.projectRoot);

  // The stack is known; now make it runnable. A vibecoder who has never
  // installed a test runner is the ordinary customer, not an edge case, so the
  // runner (and, where the language allows it, the application's own
  // dependencies) is installed under `.unitbob/` rather than reported as a
  // reason they cannot use the product. Nothing in their project is written to.
  //
  // A project that already has its runner is left completely alone — see
  // `ensureStructuralRunner` — so this costs nothing on a set-up machine.
  const setupNotices: string[] = [];
  if (check.runner) {
    const provisioned = await actual.ensureStructuralRunner(config.projectRoot, check.runner);
    if (provisioned.status === 'fixable') {
      const steps = provisioned.checklist?.length ? `\n  - ${provisioned.checklist.join('\n  - ')}` : '';
      throw new ToolchainUnavailableError(
        `The ${check.runner} runner could not be installed under .unitbob/, and nothing can run without it: ` +
          `${provisioned.message ?? 'provisioning failed'}${steps}\nNothing was written and nothing was uploaded.`,
        config.projectRoot,
      );
    }
    setupNotices.push(...(provisioned.checklist ?? []));

    // Confirm rather than assume. Provisioning reporting success and the runner
    // actually being startable are two different facts, and this is the cheap
    // one to check before a whole generation is built on it.
    const ready = actual.confirmRunner(config.projectRoot, check.runner);
    if (!ready.ok) {
      throw new ToolchainUnavailableError(
        ready.message ?? `The ${check.runner} runner is not available.`,
        config.projectRoot,
      );
    }
  }

  // Spec 32-6. Before anything is fetched or written, find out whether the suite
  // would get off the ground at all. It runs here, after the boot helper exists
  // and before the network, so a project whose suite cannot start costs one
  // command instead of a full generation.
  //
  // There is no `--on-broken-boot` flag and no mode. The decision is not a
  // policy we could reasonably let a user set — it follows from the fact: we
  // tried to load the thing the suite starts with, it did not load, therefore
  // not one test would reach its first assertion. Debugging generation against a
  // knowingly dead project is our problem, not the vibecoder's.
  // The stack the precheck just identified, rather than a second detection of
  // the same thing: on Python that would shell out to pytest all over again.
  const structuralRunner = check.runner ?? null;
  const boot = await actual.bootCheck(config.projectRoot, structuralRunner);
  if (boot.status === 'broken') {
    // "Your environment is not ready" is the one of the two that a container can
    // answer — the toolchain is missing here and may be sitting in one. A defect
    // found in the code is a defect wherever it runs, and offering a container
    // for it would be the noise this spec is trying to remove.
    throw boot.cause === 'environment_not_ready'
      ? new ToolchainUnavailableError(bootFinding(boot, structuralRunner), config.projectRoot)
      : new Error(bootFinding(boot, structuralRunner));
  }
  actual.stdout.write(bootFinding(boot, structuralRunner));

  const packets = await actual.getSuitePacketsBatch();

  // Spec 32-1: Zero-touch sidecar provision for behavioral BDD runners during build preflight.
  // A `fixable` outcome (no package manager available to install the runner) is an infrastructure
  // blocker the vibecoder clears with one command. Per the spec it must NOT surface as a
  // build_error dead-end, must NOT abort the build, and must NOT block the structural peer. So we
  // drop only the unprovisioned behavioral branch from this run, keep everything else buildable,
  // and print a fixable checklist after the request is written.
  const fixableNotices: string[] = [];
  const buildable: { packet: SuitePacket; runner?: string }[] = [];
  for (const packet of packets) {
    const runner = (packet as { runner?: string }).runner
      ?? (packet.suite_kind === 'behavioral' ? detectBddRunner(config.projectRoot) ?? undefined : undefined);
    if (runner && (packet.suite_kind === 'behavioral' || ['cucumber', 'cucumber-js', 'pytest-bdd'].includes(runner))) {
      const prov = await actual.ensureRunner(config.projectRoot, runner);
      if (prov.status === 'fixable') {
        const steps = prov.checklist?.length ? `\n    - ${prov.checklist.join('\n    - ')}` : '';
        fixableNotices.push(`  Behavioral runner "${runner}" not installed: ${prov.message ?? ''}${steps}`);
        continue;
      }
      // Every BDD runner with a connector-owned harness gets it here, before its
      // branch is offered to the host (spec 35-1). Only Ruby is probed by
      // running it: the Ruby World integrates deeply with Rails, and the probe
      // needs an application to integrate with. The JS and Python harnesses do
      // one thing — refuse connections that leave the machine — and their
      // guards are executed for real in the connector's own suite.
      materializeBehavioralWorld(config.projectRoot, runner);
      if (runner === 'cucumber') {
        const probe = await actual.worldProbe(config.projectRoot);
        if (probe.status === 'fixable') {
          fixableNotices.push(`  Behavioral World profile is not ready (fixable): ${probe.message ?? 'probe failed'}`);
          continue;
        }
      }
    }
    buildable.push({ packet, runner });
  }

  const prepared = await Promise.all(
    buildable.map(async ({ packet, runner }) => {
      // Read after provisioning, never before: the behavioral envelope carries
      // the version that is now installed in the sidecar.
      const manifest = actual.runnerEnvelope(packet, runner, config.projectRoot);
      if (!manifest) return { packet, runner, branch: null };

      // Spec 44, §3.2. The rule for which step files this runner loads travels
      // with the branch that will be written against it, so nobody has to read
      // the connector's own source to find it out — which is exactly what two
      // coordinators did.
      const stepLoading = packet.suite_kind === 'behavioral' && runner ? bddStepLoading(runner) : null;

      return {
        packet,
        runner,
        branch: {
          suite_kind: packet.suite_kind,
          source_digest: packet.source_digest,
          path_root: packet.path_root,
          recipe: await actual.getRecipe(recipeNameFor(packet)),
          assignment: packet.assignment,
          runner_manifest: manifest,
          ...(stepLoading ? { step_loading: stepLoading } : {}),
        },
      };
    }),
  );

  // A branch without a complete envelope is not handed to the host at all. The
  // host has nothing to compose it from — that composition is what this replaced
  // — so writing the branch anyway only moves the same rejection to the end of
  // the run, hours later.
  const branches: SuiteBuildBranch[] = [];
  const blockedNotices: string[] = [];
  for (const { packet, runner, branch } of prepared) {
    if (branch) branches.push(branch);
    else blockedNotices.push(`  ${packet.suite_kind}: ${envelopeBlockedReason(packet, runner)}`);
  }

  if (branches.length === 0) {
    throw new Error(
      `No suite branch can be built this run:\n${blockedNotices.join('\n')}\nNothing was written and nothing was uploaded.`,
    );
  }

  const request = writeSuiteBuildRequest(config.projectRoot, branches, defectContext);

  // Spec 37-1. The assignment names entrypoints; the packets are the files
  // behind them, resolved from this machine's own graph and copied where a
  // worker can open them. Built here because the entrypoints are known from the
  // request and the workers are not yet — a packet belongs to an entrypoint,
  // not to whoever ends up guarding it.
  //
  // Not written into `request.json`: the coordinator reads that file whole and
  // pays for it on every turn of the longest-lived context in the run.
  const sourcePackets = buildPackets(config.projectRoot, request);

  // A new request is a new build, and a new build has no previous run to be
  // stuck against (spec 34-6, criterion 3). Re-running this verb is a documented
  // step of the loop, so a failure set remembered from the build before it would
  // stop a branch that has not run once yet.
  clearRunState(config.projectRoot);

  const kinds = branches.map((branch) => branch.suite_kind).join(' and ');
  const nextCommand = branches.some((branch) => branch.suite_kind === 'behavioral')
    ? '`unitbob suite-review-prepare` before upload'
    : '`unitbob put-suite-build`';

  actual.stdout.write(`Suite build request written to ${request.project_root}/.unitbob/suite-build/request.json\n`);
  actual.stdout.write(packetNotice(request.project_root, sourcePackets));
  actual.stdout.write(
    `Next: build ${branches.length === 1 ? 'the' : 'both'} peer ${branches.length === 1 ? 'suite' : 'suites'} (${kinds}) following each branch's \`recipe\` and \`assignment\`, ` +
      `write your answer to ${request.output_path} as a branches array — one entry per branch named above, and a branch you cannot ` +
      `finish says so in its own entry rather than being left out of the array. Run each locally with \`unitbob run-local\` (the same ` +
      `runner that runs after publishing, so you never have to guess the command), repair broken harness steps while application failures remain red, ` +
      `then run ${nextCommand}.\n`,
  );

  // Printed as well as written, because a rule nobody reads is a rule nobody
  // follows — and this one is silent when broken: a step file the runner does
  // not collect produces no error, only a green run over no scenarios.
  for (const { packet, runner, branch } of prepared) {
    if (!branch || packet.suite_kind !== 'behavioral' || !runner) continue;

    // Before the steps are written, not after they misbehave: what this runner
    // does and does not load is the fact a worker needs while deciding what a
    // step may assume (spec 35-1, criterion 2).
    const harness = behavioralHarnessNotice(runner);
    if (harness) actual.stdout.write(harness);

    actual.stdout.write(
      branch.step_loading
        ? stepLoadingNotice(runner, branch.step_loading)
        // Said rather than left blank. This connector has no strategy for that
        // runner, so it does not know which files it loads — and silence here
        // reads as "any name will do", which is the failure this whole notice
        // exists to prevent.
        : `\nBehavioral steps run under "${runner}", and this connector does not know how that runner ` +
          'finds its step files — it has no strategy of that name. Nothing here tells you what to call ' +
          'them, and this connector will not be able to run the branch either.\n',
    );
  }

  // A fixable runner blocker is not a failure: the structural suite still builds this run. Tell the
  // vibecoder the one command that unblocks the behavioral peer, then re-run suite-prepare.
  if (setupNotices.length > 0) {
    actual.stdout.write(
      '\nOne setup step is worth knowing about before you generate:\n  - ' + setupNotices.join('\n  - ') + '\n',
    );
  }

  if (fixableNotices.length > 0) {
    actual.stdout.write(
      '\nBehavioral suite skipped this run — its runner or connector-owned World profile is not ready. ' +
        'This is a fixable setup step, not a build failure, and it does not affect the structural suite:\n' +
        fixableNotices.join('\n') +
        '\nFix the above, then re-run `unitbob suite-prepare` to build the behavioral peer.\n',
    );
  }

  // Same shape, different cause: this branch has an assignment but no runner
  // envelope to upload it with, so it is not offered to the host at all. Its
  // peer above is unaffected.
  if (blockedNotices.length > 0) {
    actual.stdout.write(
      '\nOne suite branch was left out of this run — it has no runner manifest, and the server ' +
        'accepts an upload only with one:\n' +
        blockedNotices.join('\n') +
        '\n',
    );
  }
}

// A checkout we cannot write packets into is a run without packets, not a
// failed build: the workers search the source themselves, exactly as they did
// before this spec. The same rule the route inventory follows for the same
// reason — a read-only checkout or a full disk must not take a build down.
function buildPackets(projectRoot: string, request: SuiteBuildRequest): SuitePacketsSummary | string {
  try {
    return writeSuitePackets(projectRoot, request);
  } catch (err) {
    return (err as Error).message;
  }
}

function packetNotice(projectRoot: string, packets: SuitePacketsSummary | string): string {
  if (typeof packets === 'string') {
    return (
      `\nNo packets were written this run (${packets}). Workers find their own source, as before.\n`
    );
  }
  if (packets.targets === 0) return '';

  const where = `${projectRoot}/${PACKETS_DIR}`;
  const head =
    packets.files === 0
      ? `\nNo packet was written this run, so ${where} holds only its index.\n`
      : `\n${packets.files} ${packets.files === 1 ? 'packet' : 'packets'} (${packets.bytes.toLocaleString('en-US')} bytes) ` +
        `written to ${where}: the source behind ${packets.resolved} of ${packets.targets} entrypoints, resolved from this ` +
        `machine's own graph and route inventory without asking a model. Hand each worker the paths of its packets, ` +
        'never their contents — `unitbob validate-worker-plan` prints them per worker.\n';

  // Two different outcomes, never merged: a file that was found and not carried
  // still saves the worker the search, and a name nothing answered to does not.
  const carried = packets.located - packets.resolved;
  const unknown = packets.targets - packets.located;
  if (carried === 0 && unknown === 0) return head;
  return (
    head +
    `${carried + unknown} of ${packets.targets} entrypoints have no packet` +
    (carried > 0 ? `; ${carried} name a file that was found but not carried` : '') +
    ` (${packets.notes.join('; ')}). ` +
    `Each says why in ${where}/index.json.\n`
  );
}

// The runner's own rule for which step files it will load, in the words of the
// side that loads them (spec ask-before-you-spend, §3.2). The same object is in `request.json`, on
// the behavioral branch; this is the copy the coordinator sees without opening a
// file.
//
// A null pattern is printed as a null pattern. A runner whose rule is not one
// pattern says what it does know and admits the rest — inventing a pattern here
// would recreate, in the connector this time, exactly the retelling this
// replaced.
function stepLoadingNotice(runner: string, loading: BddStepLoading): string {
  const rule = loading.step_files
    ? `it loads \`${loading.step_files}\` from \`.unitbob/behavioral/step_definitions/\` — put the capability id ` +
      'where the `*` is, and a file named anything else is not loaded at all'
    : 'its rule for which files it loads is not one pattern, and this connector will not state one for it';

  return (
    `\nBehavioral steps run under "${runner}", and ${rule}. What else has to be true of a step file there:\n  - ` +
    loading.requirements.join('\n  - ') +
    '\nThis is also in `request.json`, on the behavioral branch, as `step_loading`.\n'
  );
}

// What the boot check found, in the vibecoder's terms. Printed on every run,
// including the quiet ones: "we looked and it starts" and "we could not look"
// are both worth a line, and a check nobody hears about is a check nobody
// trusts.
//
// A stop here is a finding, not a refusal, and the wording has to carry that.
// "We found the defect that stops your suite from starting" and "we could not
// build your suite" describe the same event and leave the reader in completely
// different places.
function bootFinding(boot: BootCheck, runner: string | null): string {
  // Both halves of "what this answer is worth" travel together, on every
  // outcome. Splitting them is how the stack caveat came to be missing from
  // `broken`, and pinning `STRUCTURAL_ONLY` to `ok` alone would have repeated
  // that in the same breath as the fix: on Rails the stack caveat reads
  // "whatever stops one stops the other", which is an unscoped claim about a
  // branch nobody asked — loudest exactly where the run stops for both.
  // Empties are dropped rather than joined blindly, so a runner with no caveat
  // of its own does not leave a blank line behind.
  const caveat = [runner ? SIGNAL_STRENGTH[runner] : '', runner ? STRUCTURAL_ONLY : '']
    .filter(Boolean)
    .map((line) => `\n${line}`)
    .join('');

  if (boot.status === 'ok') {
    return `Checked that the suite can start: it does.${caveat}\n`;
  }

  if (boot.status === 'not_checked') {
    // Not checked is not broken, and nothing downstream may treat it as such.
    // Conflating the two would block honest projects — the whole reason this
    // state is named for what happened rather than for what we know.
    const said = boot.detail ? `\n\n  ${boot.detail}\n` : '';
    return `${NOT_CHECKED_REASON[boot.reason]}${said} Generation continues.${caveat}\n`;
  }

  const headline =
    boot.cause === 'defect_in_code'
      ? 'Found a defect that stops your test suite from starting.'
      : 'Your test suite cannot start yet — its environment is not ready.';

  // The runner's own words. Everything else on screen is ours; this line is
  // the one the vibecoder can paste into a search.
  const next =
    boot.cause === 'defect_in_code'
      ? 'Fix that, then run `unitbob suite-prepare` again.'
      : 'Unitbob installs the runner, and your declared dependencies with it, into `.unitbob/runners/` — ' +
        'it never writes to your project. Something outside that file is still missing here. Run the ' +
        'install your project needs (`bundle install`, `npm install`, `pip install -r requirements.txt`), ' +
        'then run `unitbob suite-prepare` again.';

  return (
    `${headline}\n\n` +
    `  ${boot.message}\n\n` +
    `${boot.detail}\n\n` +
    'No suite was written and nothing was uploaded — every test would have died on that line ' +
    // The caveat belongs here most of all, and this was the one branch it did
    // not reach — found on the fifth implementation review, 2026-08-03. On
    // pytest and vitest the check collects the project's whole test tree, so
    // the line above may come from a test of the project's own that the Unitbob
    // suite would never have imported. Printing "found a defect" and keeping
    // that back sends someone to fix a file this product was never going to
    // touch, which is the same over-claim the spec accepted the wide check only
    // on condition of disclosing.
    `before reaching its first assertion. ${next}${caveat}\n`
  );
}

// Spec 32-6 says the boot rule is one rule for both branches; this check asks
// one of them. It is made against the *structural* runner, which is what
// `precheck` identified and what the materialized helper belongs to. The
// behavioral branch starts elsewhere — cucumber with its own `features/support`,
// cucumber-js with its own — and there is nothing of ours to load there yet:
// at this point in `suite-prepare` the behavioral suite has not been generated.
// Asking the question anyway would mean booting the project's own feature
// files, which is *wider* than the condition that stops the Unitbob run — the
// one thing this module's governing rule forbids ("the condition we test must
// equal the condition that makes a run impossible, never exceed it").
//
// So the boundary is stated instead of crossed. Recorded on the fifth
// implementation review, 2026-08-03, and written into the spec beside it.
const STRUCTURAL_ONLY =
  'This says nothing about the product-behaviour branch: it starts with a runner of its own, ' +
  'which has nothing of ours to load until its suite exists, so it was not asked.';

const NOT_CHECKED_REASON: Record<
  'no_runner' | 'runner_too_old' | 'runner_could_not_answer' | 'timed_out' | 'nothing_to_load' | 'place_failed',
  string
> = {
  no_runner: 'Did not check whether the suite can start: no runner available to load it with.',
  // Distinct from `no_runner` on purpose. The runner is installed and working;
  // it is only too old to be asked this particular question, and "no runner
  // available" would send someone to fix a thing that is not broken.
  runner_too_old:
    'Did not check whether the suite can start: the installed runner is too old to be asked. ' +
    'Nothing is wrong with it — this check simply has no way to pose the question to that version.',
  // Distinct for the same reason, one step further along: the runner is there
  // and current, it was reached, and it declined to answer — pytest exiting on
  // a usage or internal error of its own. That says nothing about the project,
  // and "no runner available" would again send someone after the wrong thing.
  runner_could_not_answer:
    'Did not check whether the suite can start: the runner could not answer the question — it ' +
    'stopped on an error of its own before loading anything. Nothing was learned about your code either way.',
  timed_out: 'Did not check whether the suite can start: loading it took too long and was stopped.',
  nothing_to_load: 'Did not check whether the suite can start: there was nothing to load yet.',
  // Spec 36, criterion 8. Docker refused, or the container went away between the
  // check and the spawn. Nothing here says anything about the project, and the
  // one thing this must never turn into is "we found a defect in your code".
  place_failed:
    'Did not check whether the suite can start: the place this project runs in did not carry the command ' +
    'out. That is a fault of the container or the docker daemon, not of your code, and nothing was learned ' +
    'about your code either way.',
};

function knownDefectContext(args: string[]): KnownDefectContext {
  const defect = option(args, '--known-defect=');
  const fixedRevision = option(args, '--fixed-revision=');
  const explicitlyAbsent = args.includes('--no-known-defect');
  if ((defect && explicitlyAbsent) || (!defect && !explicitlyAbsent)) {
    throw new Error('Choose exactly one of --known-defect or --no-known-defect (use --known-defect=<description>).');
  }
  if (fixedRevision && !defect) throw new Error('--fixed-revision requires --known-defect.');
  if (explicitlyAbsent) return { status: 'not_supplied' };
  if (!defect) throw new Error('--known-defect requires a value.');
  return {
    status: 'supplied',
    defect,
    ...(fixedRevision ? { fixed_revision: fixedRevision } : {}),
  };
}

function option(args: string[], prefix: string): string | undefined {
  const match = args.find((arg) => arg.startsWith(prefix));
  const value = match?.slice(prefix.length).trim();
  if (match && !value) throw new Error(`${prefix.slice(0, -1)} requires a value.`);
  return value || undefined;
}
