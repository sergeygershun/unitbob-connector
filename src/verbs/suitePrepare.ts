import type { Config } from '../config.ts';
import { writeSuiteBuildRequest } from '../files/suiteBuild.ts';
import { Wire, type Recipe, type SuitePackets } from '../wire.ts';

interface SuitePrepareDeps {
  getRecipe: (name: string) => Promise<Recipe>;
  getSuitePackets: () => Promise<SuitePackets>;
}

// Fetch the generate recipe and the per-block packets, then write the host's
// task to `.unitbob/suite-build/request.json`. No model is called and no source
// is read here — that is the host's job, framed by ai/agents/suite_builder.md.
// A no-current-map error from the server surfaces (via WireError) with guidance
// to run `/unitbob map` first; nothing is written or uploaded.
export async function suitePrepare(config: Config, _args: string[] = [], deps?: Partial<SuitePrepareDeps>): Promise<void> {
  const wire = new Wire(config);
  const actual: SuitePrepareDeps = {
    getRecipe: (name) => wire.getRecipe(name),
    getSuitePackets: () => wire.getSuitePackets(),
    ...deps,
  };

  const [recipe, packets] = await Promise.all([actual.getRecipe('generate'), actual.getSuitePackets()]);
  const request = writeSuiteBuildRequest(config.projectRoot, {
    map_digest: packets.map_digest,
    recipe,
    packets: packets.packets,
  });

  process.stdout.write(`Suite build request written to ${request.project_root}/.unitbob/suite-build/request.json\n`);
}
