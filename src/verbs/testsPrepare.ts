import type { Config } from '../config.ts';
import { materializeBehavioralUnion, materializeBehavioralWorld } from '../files/behavioral.ts';
import {
  featureFeaturePath,
  featureStepsPath,
  knowledgePath,
  parseFeatureId,
  testsOutputPath,
  testsRequestPath,
  writeTestsRequest,
} from '../files/features.ts';
import { installedRunnerVersion, selectRunnerEnvelope } from '../runner/manifest.ts';
import { placeProblem } from '../runner/place.ts';
import { detectBddRunner } from '../runner/precheck.ts';
import { ensureRunner, type ProvisionResult } from '../runner/provision.ts';
import { ToolchainUnavailableError } from '../runner/toolchain.ts';
import { Wire, type Recipe, type RunnerManifestWire, type SuiteIndex, type TestsPacket } from '../wire.ts';
import { assertKnowledgeUnchanged } from './putTests.ts';

interface TestsPrepareDeps {
  getTestsPacket: (featureId: number) => Promise<TestsPacket>;
  getRecipe: (name: string) => Promise<Recipe>;
  getSuiteIndex: () => Promise<SuiteIndex>;
  detectRunner: (projectRoot: string) => string | null;
  ensureRunner: (projectRoot: string, runner: string) => Promise<ProvisionResult>;
  // The pinned version of the runner installed under `.unitbob/behavioral/`,
  // read back from that environment (see `runner/manifest.ts`).
  installedVersion: (runner: string, projectRoot: string) => string | null;
  stdout: { write: (chunk: string) => unknown };
}

// `tests-prepare <feature_id>` (spec 52-3, AC 3.4): the host's task for writing
// a feature's checks. The packet (a 409 before the talk is the server's own
// sentence, let through), then the knowledge file on disk held to the server's
// digest — the checks are written from that file, and a file edited after the
// talk would put text under seal the person never confirmed — then the recipe,
// the union of the main suite and every red feature's checks on disk (the
// shared steps to reuse, the base for rewriting the wiring at `red`), the
// runner provisioned as `suite-prepare` provisions it, the World in place, and
// `tests-request.json` beside the talk's request. No model is called, nothing
// is uploaded.
export async function testsPrepare(config: Config, args: string[] = [], deps?: Partial<TestsPrepareDeps>): Promise<void> {
  const wire = new Wire(config);
  const d: TestsPrepareDeps = {
    getTestsPacket: (id) => wire.getTestsPacket(id),
    getRecipe: (name) => wire.getRecipe(name),
    getSuiteIndex: () => wire.getSuiteIndex(),
    detectRunner: detectBddRunner,
    ensureRunner,
    installedVersion: installedRunnerVersion,
    stdout: process.stdout,
    ...deps,
  };

  const featureId = parseFeatureId(args[0], 'tests-prepare');
  const unusable = placeProblem(config.projectRoot);
  if (unusable) throw new Error(unusable);

  const packet = await d.getTestsPacket(featureId);
  assertKnowledgeUnchanged(config.projectRoot, featureId, packet.knowledge_digest);

  const [recipe, index] = await Promise.all([d.getRecipe('feature_tests'), d.getSuiteIndex()]);

  // The main suite's runner when it is built — the checks share its directory
  // and its steps, so they cannot run on another — else the one this stack
  // selects, as `suite-prepare` does.
  const runner = packet.main_suite === 'not_built' ? d.detectRunner(config.projectRoot) : packet.main_suite.runner;
  if (!runner) {
    throw new Error('This project matches no BDD runner the connector can run — the checks cannot be written on it.');
  }
  const provisioned = await d.ensureRunner(config.projectRoot, runner);
  if (provisioned.status === 'fixable') {
    const steps = provisioned.checklist?.length ? `\n  - ${provisioned.checklist.join('\n  - ')}` : '';
    throw new ToolchainUnavailableError(
      `The "${runner}" runner could not be installed under .unitbob/, and the checks cannot run without it: ` +
        `${provisioned.message ?? 'provisioning failed'}${steps}\nNothing was written.`,
      config.projectRoot,
    );
  }
  const selected = selectRunnerEnvelope(packet.runner_manifests, runner) as RunnerManifestWire | null;
  const version = d.installedVersion(runner, config.projectRoot);
  if (!selected || !version) {
    throw new Error(
      `The version of "${runner}" installed under .unitbob/behavioral/ could not be read, and the server requires it. ` +
        'Re-run `unitbob suite-prepare` so the runner is provisioned again.',
    );
  }

  materializeBehavioralUnion(config.projectRoot, index, runner);
  materializeBehavioralWorld(config.projectRoot, runner);

  writeTestsRequest(config.projectRoot, featureId, {
    project_root: config.projectRoot,
    recipe,
    feature: packet.feature,
    feature_tag: packet.feature_tag,
    assignment: packet.assignment,
    scenarios: packet.scenarios,
    knowledge_path: knowledgePath(config.projectRoot, featureId),
    knowledge_digest: packet.knowledge_digest,
    runner,
    runner_manifest: { ...selected, runner_version: version },
    main_suite: packet.main_suite,
    feature_path: featureFeaturePath(featureId),
    steps_path: featureStepsPath(featureId, runner),
    output_path: testsOutputPath(config.projectRoot, featureId),
  });
  d.stdout.write(`Tests request written to ${testsRequestPath(config.projectRoot, featureId)}\n`);
}
