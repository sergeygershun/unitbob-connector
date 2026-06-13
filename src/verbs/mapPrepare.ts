import type { Config } from '../config.ts';
import { ensureUnitbobIgnored, requireGraphify, runGraphifyExtract } from '../proc.ts';
import { readFreshGraph, writeMapBuildRequest } from '../files/mapBuild.ts';
import { Wire, type Recipe } from '../wire.ts';

interface MapPrepareDeps {
  requireGraphify: () => Promise<void>;
  ensureUnitbobIgnored: (projectRoot: string) => void;
  runGraphifyExtract: (projectRoot: string) => Promise<{ stdout: string; stderr: string; code: number | null }>;
  getRecipe: (name: string) => Promise<Recipe>;
}

export async function mapPrepare(config: Config, _args: string[] = [], deps?: Partial<MapPrepareDeps>): Promise<void> {
  const wire = new Wire(config);
  const actual: MapPrepareDeps = {
    requireGraphify,
    ensureUnitbobIgnored,
    runGraphifyExtract,
    getRecipe: (name) => wire.getRecipe(name),
    ...deps,
  };

  actual.ensureUnitbobIgnored(config.projectRoot);
  await actual.requireGraphify();

  const result = await actual.runGraphifyExtract(config.projectRoot);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `graphify exited ${result.code}`;
    throw new Error(`graphify extract failed: ${detail}`);
  }

  readFreshGraph(config.projectRoot);
  const [decompose, relate] = await Promise.all([actual.getRecipe('decompose'), actual.getRecipe('relate')]);
  const packet = writeMapBuildRequest(config.projectRoot, { decompose, relate });

  process.stdout.write(`Map build request written to ${packet.project_root}/.unitbob/map-build/request.json\n`);
}
