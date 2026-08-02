import type { Config } from '../config.ts';
import { ensureUnitbobIgnored, requireGraphify, runGraphifyExtractKeyless } from '../proc.ts';
import { readFreshGraph, writeMapBuildRequest } from '../files/mapBuild.ts';
import {
  describeRouteInventory,
  extractRouteInventory,
  type RouteInventory,
} from '../surfaces/routeInventory.ts';
import { Wire, type Recipe } from '../wire.ts';

interface MapPrepareDeps {
  requireGraphify: () => Promise<void>;
  ensureUnitbobIgnored: (projectRoot: string) => void;
  runGraphifyExtractKeyless: (projectRoot: string) => Promise<{ stdout: string; stderr: string; code: number | null }>;
  extractRouteInventory: (projectRoot: string) => Promise<RouteInventory>;
  getRecipe: (name: string) => Promise<Recipe>;
}

export async function mapPrepare(config: Config, _args: string[] = [], deps?: Partial<MapPrepareDeps>): Promise<void> {
  const wire = new Wire(config);
  const actual: MapPrepareDeps = {
    requireGraphify,
    ensureUnitbobIgnored,
    runGraphifyExtractKeyless,
    extractRouteInventory,
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

  // Asked here rather than left to the workflow as a step of its own (spec
  // 32-7). The graph has just been refreshed, which is what the addresses are
  // linked against, and a step an instruction can skip is a step that gets
  // skipped — the lesson spec 32-4 paid for. Silence costs nothing: the request
  // simply carries no inventory and the recipe reads the source.
  //
  // Said out loud first, because asking a router means booting the application
  // and that can take a minute or two with nothing on the screen. Silence from
  // us there reads as a hang.
  process.stdout.write('Asking this project for the addresses it declares (this boots the application)…\n');
  const inventory = await actual.extractRouteInventory(config.projectRoot);

  const [decompose, relate, extractSurfaces, decomposeSurfaces] = await Promise.all([
    actual.getRecipe('decompose'),
    actual.getRecipe('relate'),
    actual.getRecipe('extract_surfaces'),
    actual.getRecipe('decompose_surfaces'),
  ]);
  const packet = writeMapBuildRequest(
    config.projectRoot,
    {
      decompose,
      relate,
      extract_surfaces: extractSurfaces,
      decompose_surfaces: decomposeSurfaces,
    },
    inventory.status === 'written' ? inventory.path : undefined,
  );

  process.stdout.write(`Map build request written to ${packet.project_root}/.unitbob/map-build/request.json\n`);
  process.stdout.write(`${describeRouteInventory(inventory)}\n`);
  process.stdout.write(
    `Next: build BOTH lenses following the recipes in that request — the decompose map at ` +
      `${packet.output_path} (recipes.decompose, recipes.relate), and the surface map at ` +
      `${packet.surface_output_path} (recipes.extract_surfaces → ${packet.surfaces_path}, then ` +
      'recipes.decompose_surfaces) — then run `unitbob put-map-build`.\n',
  );
}
