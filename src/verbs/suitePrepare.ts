import type { Config } from '../config.ts';
import { materializeHelper } from '../files/guardrails.ts';
import {
  recipeNameFor,
  writeSuiteBuildRequest,
  type KnownDefectContext,
  type SuiteBuildBranch,
} from '../files/suiteBuild.ts';
import { bootCheck, SIGNAL_STRENGTH, type BootCheck } from '../runner/bootcheck.ts';
import { anyStackPrecheck, detectBddRunner, detectStructuralRunner } from '../runner/precheck.ts';
import { selectRunnerEnvelope, withInstalledRunnerVersion, type RunnerEnvelope } from '../runner/manifest.ts';
import { ensureRunner, type ProvisionResult } from '../runner/provision.ts';
import { Wire, type Recipe, type SuitePacket } from '../wire.ts';

interface SuitePrepareDeps {
  getRecipe: (name: string) => Promise<Recipe>;
  getSuitePacketsBatch: () => Promise<SuitePacket[]>;
  precheck: (projectRoot: string) => { ok: boolean; message?: string; runner?: string };
  bootCheck: (projectRoot: string, runner: string | null) => Promise<BootCheck>;
  ensureRunner: (projectRoot: string, runner: string) => Promise<ProvisionResult>;
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
// helper a generated RSpec suite would require, then fetch both peer assignments
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
    bootCheck: (projectRoot, runner) => bootCheck(projectRoot, runner),
    ensureRunner: deps?.ensureRunner ?? ensureRunner,
    runnerEnvelope: runnerEnvelopeFor,
    stdout: process.stdout,
    ...deps,
  };

  const check = actual.precheck(config.projectRoot);
  if (!check.ok) throw new Error(check.message ?? 'Unsupported runtime.');

  materializeHelper(config.projectRoot);

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
  if (boot.status === 'broken') throw new Error(bootFinding(boot, structuralRunner));
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
    }
    buildable.push({ packet, runner });
  }

  const prepared = await Promise.all(
    buildable.map(async ({ packet, runner }) => {
      // Read after provisioning, never before: the behavioral envelope carries
      // the version that is now installed in the sidecar.
      const manifest = actual.runnerEnvelope(packet, runner, config.projectRoot);
      if (!manifest) return { packet, runner, branch: null };

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
  const kinds = branches.map((branch) => branch.suite_kind).join(' and ');
  const nextCommand = branches.some((branch) => branch.suite_kind === 'behavioral')
    ? '`unitbob suite-review-prepare` before upload'
    : '`unitbob put-suite-build`';

  actual.stdout.write(`Suite build request written to ${request.project_root}/.unitbob/suite-build/request.json\n`);
  actual.stdout.write(
    `Next: build ${branches.length === 1 ? 'the' : 'both'} peer ${branches.length === 1 ? 'suite' : 'suites'} (${kinds}) following each branch's \`recipe\` and \`assignment\`, ` +
      `write your answer to ${request.output_path} as a branches array, run each locally, repair broken harness steps while application failures remain red, ` +
      `then run ${nextCommand}.\n`,
  );

  // A fixable runner blocker is not a failure: the structural suite still builds this run. Tell the
  // vibecoder the one command that unblocks the behavioral peer, then re-run suite-prepare.
  if (fixableNotices.length > 0) {
    actual.stdout.write(
      '\nBehavioral suite skipped this run — its BDD runner is not installed yet. ' +
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
  const caveat = runner ? `\n${SIGNAL_STRENGTH[runner] ?? ''}` : '';

  if (boot.status === 'ok') {
    return `Checked that the suite can start: it does.${caveat}\n`;
  }

  if (boot.status === 'not_checked') {
    // Not checked is not broken, and nothing downstream may treat it as such.
    // Conflating the two would block honest projects — the whole reason this
    // state is named for what happened rather than for what we know.
    return `${NOT_CHECKED_REASON[boot.reason]} Generation continues.${caveat}\n`;
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
      : "Unitbob does not install your project's own dependencies — that would rewrite your Gemfile.lock " +
        'or package-lock.json. Run the install your project needs (`bundle install`, `npm install`, ' +
        '`pip install -r requirements.txt`), then run `unitbob suite-prepare` again.';

  return (
    `${headline}\n\n` +
    `  ${boot.message}\n\n` +
    `${boot.detail}\n\n` +
    'No suite was written and nothing was uploaded — every test would have died on that line ' +
    `before reaching its first assertion. ${next}\n`
  );
}

const NOT_CHECKED_REASON: Record<
  'no_runner' | 'runner_too_old' | 'runner_could_not_answer' | 'timed_out' | 'nothing_to_load',
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
