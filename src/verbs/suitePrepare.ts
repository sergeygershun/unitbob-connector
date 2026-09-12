import type { Config } from '../config.ts';
import { clearRunState } from '../runner/failureDigest.ts';
import { materializeHelper } from '../files/guardrails.ts';
import { materializeBehavioralWorld } from '../files/behavioral.ts';
import {
  PACKETS_DIR,
  structuralSourceFiles,
  writeSuitePackets,
  type SuitePacketsSummary,
} from '../files/packets.ts';
import {
  isNewBuild,
  movePreviousRunAside,
  recipeNameFor,
  writeSuiteBuildRequest,
  type BranchKind,
  type KnownDefectContext,
  type PreviousRunMoved,
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
import { canPrepareBeforeImports, setupFileOf, STRUCTURAL_SETUP_FILE } from '../runner/vitest.ts';
import { probeBehavioralWorld, type WorldProbeResult } from '../runner/worldProbe.ts';
import { Wire, type Recipe, type SuiteIndex, type SuitePacket } from '../wire.ts';

interface SuitePrepareDeps {
  getRecipe: (name: string) => Promise<Recipe>;
  getSuitePacketsBatch: () => Promise<SuitePacket[]>;
  // The checks of every red feature (spec 52-3): their tags go into the
  // request, so the runs this build makes leave them out.
  getSuiteIndex: () => Promise<SuiteIndex>;
  precheck: (projectRoot: string) => { ok: boolean; message?: string; runner?: string };
  confirmRunner: (projectRoot: string, runner: string) => { ok: boolean; message?: string };
  bootCheck: (projectRoot: string, runner: string | null, sourceFiles: string[]) => Promise<BootCheck>;
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
    getSuiteIndex: () => wire.getSuiteIndex(),
    precheck: anyStackPrecheck,
    confirmRunner: (projectRoot, runner) => runnerReadyPrecheck(projectRoot, runner),
    bootCheck: (projectRoot, runner, sourceFiles) => bootCheck(projectRoot, runner, sourceFiles),
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

  // Spec 37-2, criterion 3, widened by spec 49. The papers a build leaves
  // behind — plan, checkpoints, answer, review — outlive the `request.json`
  // they were digested against, and every one of them is refused by its own
  // gate from here on. The suite files of both branches outlive it too, and
  // nothing refuses those: the behavioral runner loads its directory whole, so
  // a dead `.feature` runs and a dead step file argues with a live one. Moved
  // rather than removed — see `movePreviousRunAside`.
  //
  // Here, before the helper and the World are written and before the probe asks
  // its question (criterion 4): a `conftest.py` from the last build would be
  // loaded by pytest beside our probe, and a leftover `_setup.ts` would turn the
  // probe's scouting into a sentence. Only on a new build (criterion 3): a
  // repeat inside one is the coordinator's second question of the probe (spec
  // 39), and the setup file written between the two runs has to survive it.
  //
  // Wrapped, because a read-only checkout or a permission the move does not
  // have is a note, not a build that dies before it has asked the server
  // anything. And nothing is lost if a later step refuses: `request.json` of
  // the last build is still there, so the next run does not move again.
  let displaced: PreviousRunMoved = { artifacts: [], branches: { structural: 0, behavioral: 0 } };
  let displaceProblem = '';
  if (isNewBuild(config.projectRoot)) {
    try {
      displaced = movePreviousRunAside(config.projectRoot, detectBddRunner(config.projectRoot));
    } catch (err) {
      displaceProblem = (err as Error).message;
    }
  }

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

  // The stack the precheck just identified, rather than a second detection of
  // the same thing: on Python that would shell out to pytest all over again.
  // Used further down, where the boot check now runs.
  const structuralRunner = check.runner ?? null;

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

  // Spec 32-6, moved down by spec 38. Before anything is written and before a
  // single token is spent, find out whether the code this branch's guardrails
  // will import actually loads.
  //
  // Here rather than at the top of the verb, because here the list of those
  // files exists: it is resolved from the branches that were just assembled,
  // out of this machine's own graph and route inventory. Nothing is lost by
  // waiting — `getSuitePacketsBatch` is a GET that writes nothing and costs
  // nothing, and the generator, which is where the money starts, does not run
  // until `request.json` is written below.
  //
  // What is gained is that a failure here takes one branch and not the run. The
  // behavioral peer has a runner of its own, touches none of these files, and
  // used to die of a verdict that was never about it.
  // Only when there is a branch to check. Ruby's helper ignores the file list
  // and boots the application for itself, so asking with no structural branch in
  // the run would start Rails to answer a question nobody put — and a `broken`
  // answer would then report a branch this build never had.
  //
  // Spec 39 kept the sentry and moved the sentence. The probe asks its question
  // twice: once before anything has been prepared for these files, and once
  // after the coordinator has written the branch's shared setup file. Only the
  // second answer costs a branch, because only the second one asks what the run
  // will ask. Before the setup file exists the probe's question — "do these
  // files load with nothing in front of them" — is stricter than the condition
  // it stands in for, and `docs/adr/0001` forbids exactly that: the condition
  // tested must equal the condition that makes a run impossible, never exceed
  // it. Two bench projects were refused on that excess while their behavioral
  // peers built and stayed green.
  //
  // The switch is the file on disk and nothing else. No flag and no mode: 32-6
  // forbade them, and the connector has to ask this same question anyway to
  // decide whether to name the file in `setupFiles`, so a second signal could
  // only ever disagree with the first.
  //
  // And only on the stack where a preparation can actually be put in front of
  // the imports — `canPrepareBeforeImports`, which is vitest and only vitest. On
  // rspec and pytest nothing of ours runs before the branch's imports, so there
  // the probe's question already *is* the run's question: no excess to correct,
  // and a red answer costs the branch on the first run exactly as it has since
  // 32-6. Waiting for a file those stacks will never have would have quietly
  // reopened the funnel that spec closed.
  //
  // One thing this sign cannot see: a setup file left over from an earlier
  // build. It comes back with the artifact and is materialized like any other
  // file of the branch, so on a re-generation the probe sentences on its first
  // ask instead of scouting. That is the honest reading — a preparation does
  // exist and the probe went through it — and the way out is the same one the
  // verdict already names: fix that file, run `suite-prepare` again. Telling the
  // two apart would need a memory of which build wrote it, which is a mode by
  // another name, and 32-6 forbade those.
  const bootNotices: string[] = [];
  const bootAdvisories: string[] = [];
  const structuralIndex = branches.findIndex((branch) => branch.suite_kind === 'structural');
  if (structuralIndex !== -1) {
    const boot = await actual.bootCheck(
      config.projectRoot,
      structuralRunner,
      structuralSourceFiles(config.projectRoot, { branches }),
    );
    if (boot.status === 'broken') {
      if (!canPrepareBeforeImports(structuralRunner) || setupFileOf(config.projectRoot)) {
        branches.splice(structuralIndex, 1);
        bootNotices.push(bootStop(boot, structuralRunner));
      } else {
        bootAdvisories.push(bootAdvisory(boot, structuralRunner));
      }
    } else {
      actual.stdout.write(bootFinding(boot, structuralRunner));
    }
  }

  // Every reason a branch is not here, in one place. A run can lose its last
  // branch to any of the three and the reader needs the one that applies to
  // them — printing only the envelope reasons left a jest project reading an
  // empty list under "no suite branch can be built".
  if (branches.length === 0) {
    const why = [...bootNotices, ...blockedNotices, ...fixableNotices].join('\n');
    throw new Error(
      `No suite branch can be built this run:\n${why}\nNothing was written and nothing was uploaded.`,
    );
  }

  const excludeFeatureTags = (await actual.getSuiteIndex()).feature_suites.map((item) => item.feature_tag);
  const request = writeSuiteBuildRequest(config.projectRoot, branches, defectContext, excludeFeatureTags);

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
  const moved = displacedList(displaced);
  if (moved.length > 0) {
    actual.stdout.write(
      `The previous run's ${moved.join(', ')} moved to ` +
        `${request.project_root}/.unitbob/suite-build/previous/ — none of it is left where this build will ` +
        'look, and none of it was deleted.\n',
    );
  }
  if (displaceProblem) {
    actual.stdout.write(
      `\nThe previous run's files could not be moved out of the way (${displaceProblem}). This build is fine, ` +
        'but a plan or checkpoint left over from it will be refused by its own gate — the digests belong to ' +
        'the request that was just replaced — and running a branch will include files from the previous build ' +
        'still under .unitbob/structural/ and .unitbob/behavioral/.\n',
    );
  }
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

  // Same shape as the two notices below it, and the same rule: the branch that
  // could not be prepared drops out, its peer is untouched, and the reason is
  // printed rather than swallowed.
  if (bootNotices.length > 0) {
    actual.stdout.write(
      '\nThe code-structure suite was left out of this run — the source files its guardrails would ' +
        'import did not load. None of your own tests were opened; only the files the map named:\n' +
        bootNotices.join('\n') +
        '\n',
    );
  }

  // The other half of the probe's answer (spec 39), and it needs a heading of
  // its own: "was left out of this run" is true only of the verdict, and this
  // branch was not left out of anything. It is being built, and what follows is
  // the opening fact for whoever writes its preparation.
  if (bootAdvisories.length > 0) {
    actual.stdout.write(
      '\nThe code-structure suite is still being built, and here is what its source files did on their own: ' +
        `they did not load. Nothing has been put in front of them yet — that is what ${STRUCTURAL_SETUP_FILE} ` +
        'is for, and writing it comes before the fan-out. None of your own tests were opened; only the files ' +
        'the map named:\n' +
        bootAdvisories.join('\n') +
        '\n',
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

// Everything that moved, in the words the line has always used: the artifacts
// by name, then each branch as a count (spec 49, criterion 5). By-products that
// were deleted are not listed — nobody lost them.
function displacedList(moved: PreviousRunMoved): string[] {
  const branchFiles = (branch: BranchKind) => {
    const count = moved.branches[branch];
    return count > 0 ? [`${count} ${branch} ${count === 1 ? 'file' : 'files'}`] : [];
  };
  return [...moved.artifacts, ...branchFiles('structural'), ...branchFiles('behavioral')];
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
        'never their contents — `unitbob accept-worker-plan` prints them per worker.\n';

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

// What the boot check found when it found nothing wrong, in the vibecoder's
// terms. Printed on every such run, including the quiet ones: "we looked and it
// starts" and "we could not look" are both worth a line, and a check nobody
// hears about is a check nobody trusts.
//
// The third answer, `broken`, is the only one that changes what gets built, so
// it goes to `bootStop` and is printed where every other missing branch is
// explained.
function bootFinding(boot: Exclude<BootCheck, { status: 'broken' }>, runner: string | null): string {
  const caveat = caveatFor(runner);

  if (boot.status === 'ok') {
    return `Checked that the suite can start: it does.${caveat}\n`;
  }

  // Not checked is not broken, and nothing downstream may treat it as such.
  // Conflating the two would block honest projects — the whole reason this
  // state is named for what happened rather than for what we know.
  //
  // `broken` cannot arrive here: it is the one answer that changes what gets
  // built, so it goes to `bootStop` and is printed as the reason a branch is
  // missing.
  const said = boot.detail ? `\n\n  ${boot.detail}\n` : '';
  return `${NOT_CHECKED_REASON[boot.reason]}${said} Generation continues.${caveat}\n`;
}

// Why the code-structure branch is not in this run. One indented block, the same
// shape as every other missing-branch reason, because that is now what this is:
// its peer carries on, `request.json` is written, and the vibecoder comes away
// with the guardrails that branch can still give rather than with nothing.
//
// Reached only once the branch's shared setup file exists (spec 39). By then the
// probe has been asked through that preparation, so a red answer is the run's
// own answer and taking the branch is honest.
function bootStop(boot: Extract<BootCheck, { status: 'broken' }>, runner: string | null): string {
  return bootReport(boot, runner, true);
}

// The same red answer, read before anything was prepared for these files (spec
// 39). Same facts, same words from the runner, same caveat — what differs is
// the step that follows, and that is the whole difference between a scout and a
// sentry. Nothing here is worded as a verdict on somebody's code, because on
// this run it is not one: the files were asked to load with nothing in front of
// them, and putting something in front of them is Unitbob's own work.
function bootAdvisory(boot: Extract<BootCheck, { status: 'broken' }>, runner: string | null): string {
  return bootReport(boot, runner, false);
}

// The two causes keep their separate next steps. An un-run `pip install` is not
// somebody's bug and must not be worded as one; a module of theirs that raises
// on import, asked with the preparation already in place, is theirs to fix and
// pointing at an install would waste their time.
//
// The environment cause keeps the same next step in both reports: a missing gem
// is not something a setup file can prepare its way around, and sending someone
// to write one would waste the round it costs.
function bootReport(
  boot: Extract<BootCheck, { status: 'broken' }>,
  runner: string | null,
  prepared: boolean,
): string {
  const next =
    boot.cause !== 'defect_in_code'
      ? 'Unitbob installs the runner, and your declared dependencies with it, into `.unitbob/runners/` — ' +
        'it never writes to your project. Something outside that file is still missing here. Run the ' +
        'install your project needs (`bundle install`, `npm install`, `pip install -r requirements.txt`), ' +
        'then run `unitbob suite-prepare` again.'
      : prepared
        ? 'Repair it and run `unitbob suite-prepare` again to build this branch.'
        : `This is what these files do with nothing in front of them, and the run will have ` +
          `${STRUCTURAL_SETUP_FILE} in front of them. Put into that file whatever has to happen before the ` +
          'first import — the environment variables the modules read, a loader registration, and only as a ' +
          'last resort an entry through the project\'s root module — then run `unitbob suite-prepare` again ' +
          'and this same question will be asked through it.';

  // `boot.message` is the runner's own words, indented but never paraphrased:
  // this is the line the vibecoder can paste into a search.
  return `  ${boot.message}\n\n${boot.detail}\n\n  ${next}${caveatFor(runner, '  ')}\n`;
}

// What this answer is worth, in two halves that always travel together: how much
// this stack's check can see, and the fact that it speaks for one branch only.
// Splitting them is how the stack caveat came to be missing from the outcome
// that costs a branch — found on the fifth implementation review, 2026-08-03 —
// so there is one builder and every caller goes through it. `indent` sets how
// the lines sit, and is the only thing a caller may vary.
//
// Empties are dropped rather than joined blindly, so a runner with no caveat of
// its own does not leave a blank line behind.
function caveatFor(runner: string | null, indent = ''): string {
  return [runner ? SIGNAL_STRENGTH[runner] : '', runner ? STRUCTURAL_ONLY : '']
    .filter(Boolean)
    .map((line) => `\n${indent}${line}`)
    .join('');
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
  'no_runner' | 'runner_could_not_answer' | 'timed_out' | 'nothing_to_load' | 'place_failed',
  string
> = {
  no_runner: 'Did not check whether the suite can start: no runner available to load it with.',
  // Distinct from `no_runner` on purpose: the runner is there
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
