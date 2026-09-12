import type { Config } from '../config.ts';
import { requestPath, writeFeatureStartRequest, type Capability } from '../files/featureStart.ts';
import { Wire, type Recipe, type SuitePacket } from '../wire.ts';

interface FeaturePrepareDeps {
  getRecipe: (name: string) => Promise<Recipe>;
  getSuitePacketsBatch: () => Promise<SuitePacket[]>;
  stdout: { write: (chunk: string) => unknown };
}

// Fetch the recipe and the behavioral assignment — the product capabilities of
// the current map, with what each promises and where in the checkout it lives —
// and write the host's task to `.unitbob/feature-start/request.json` (spec
// 52-1). One request for the list, the same one `suite-prepare` makes; today's
// check statuses are not asked for, because they belong on the feature's page
// and not in the judgement of what the work may touch. No model is called,
// no source is read, nothing is uploaded. A 409 (no current map) surfaces as a
// WireError with the server's guidance and nothing is written.
export async function featurePrepare(
  config: Config,
  _args: string[] = [],
  deps?: Partial<FeaturePrepareDeps>,
): Promise<void> {
  const wire = new Wire(config);
  const d: FeaturePrepareDeps = {
    getRecipe: (name) => wire.getRecipe(name),
    getSuitePacketsBatch: () => wire.getSuitePacketsBatch(),
    stdout: process.stdout,
    ...deps,
  };

  const [recipe, packets] = await Promise.all([d.getRecipe('feature_intent'), d.getSuitePacketsBatch()]);
  const behavioral = packets.find((packet) => packet.suite_kind === 'behavioral');
  if (!behavioral) {
    throw new Error(
      'The Unitbob server sent no behavioral assignment with the suite packets — it is older than this connector. ' +
        'Update the server (or the connector) so the two agree, then retry.',
    );
  }

  writeFeatureStartRequest(config.projectRoot, recipe, capabilitiesOf(behavioral));
  d.stdout.write(`Feature request written to ${requestPath(config.projectRoot)}\n`);
}

// The six fields the recipe names, in the shape it names them. The contract
// identity (`contract_key`, `case_marker`) rides in the assignment for the
// suite recipe and is not copied: the host is naming what may be touched, not
// writing tests.
function capabilitiesOf(packet: SuitePacket): Capability[] {
  const assignment = (packet.assignment ?? {}) as { capabilities?: unknown };
  const list = Array.isArray(assignment.capabilities) ? assignment.capabilities : [];

  return list.map((entry) => {
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    return {
      capability_id: String(item.capability_id ?? ''),
      title: String(item.title ?? ''),
      description: String(item.description ?? ''),
      surfaces: strings(item.surfaces),
      tables: strings(item.tables),
      externals: strings(item.externals),
    };
  });
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((one) => String(one)) : [];
}
