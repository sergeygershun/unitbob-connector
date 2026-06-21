import type { Config } from '../config.ts';
import { ensureUnitbobIgnored, requireGraphify, runGraphifyExtractKeyless } from '../proc.ts';
import { readFreshGraph, writeMapBuildRequest } from '../files/mapBuild.ts';
import { Wire, type Recipe } from '../wire.ts';

interface MapPrepareDeps {
  requireGraphify: () => Promise<void>;
  ensureUnitbobIgnored: (projectRoot: string) => void;
  runGraphifyExtractKeyless: (projectRoot: string) => Promise<{ stdout: string; stderr: string; code: number | null }>;
  getRecipe: (name: string) => Promise<Recipe>;
}

export async function mapPrepare(config: Config, _args: string[] = [], deps?: Partial<MapPrepareDeps>): Promise<void> {
  const wire = new Wire(config);
  const actual: MapPrepareDeps = {
    requireGraphify,
    ensureUnitbobIgnored,
    runGraphifyExtractKeyless,
    getRecipe: (name) => wire.getRecipe(name),
    ...deps,
  };

  actual.ensureUnitbobIgnored(config.projectRoot);
  await actual.requireGraphify();

  // Keyless: refresh the one canonical graph in place. No inference secret and no
  // graph flags — semantic enrichment is host-LLM work, not a keyed LLM here.
  const result = await actual.runGraphifyExtractKeyless(config.projectRoot);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `graphify exited ${result.code}`;
    throw new Error(`graphify update failed: ${detail}`);
  }

  readFreshGraph(config.projectRoot);
  const [decompose, relate] = await Promise.all([actual.getRecipe('decompose'), actual.getRecipe('relate')]);
  const packet = writeMapBuildRequest(config.projectRoot, { decompose, relate });

  process.stdout.write(`Map build request written to ${packet.project_root}/.unitbob/map-build/request.json\n`);
  process.stdout.write(
    `Next: build the Map Document at ${packet.output_path} following recipes.decompose and ` +
      'recipes.relate inside that request, then run `unitbob put-map-build`.\n',
  );
}
