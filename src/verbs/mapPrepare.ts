import type { Config } from '../config.ts';
import { ensureUnitbobIgnored, ignoreExclusions, requireGraphify, runGraphifyExtractKeyless } from '../proc.ts';
import { readFreshGraph, writeMapBuildRequest, type ExistingCapability } from '../files/mapBuild.ts';
import {
  describeRouteInventory,
  extractRouteInventory,
  type RouteInventory,
} from '../surfaces/routeInventory.ts';
import { Wire, WireError, type FeatureListItem, type Recipe } from '../wire.ts';

interface MapPrepareDeps {
  requireGraphify: () => Promise<void>;
  ensureUnitbobIgnored: (projectRoot: string) => void;
  runGraphifyExtractKeyless: (projectRoot: string) => Promise<{ stdout: string; stderr: string; code: number | null }>;
  extractRouteInventory: (projectRoot: string) => Promise<RouteInventory>;
  getRecipe: (name: string) => Promise<Recipe>;
  listFeatures: () => Promise<{ features: FeatureListItem[]; empty_text: string }>;
  stdout: { write: (chunk: string) => unknown };
  stderr: { write: (chunk: string) => unknown };
}

export async function mapPrepare(config: Config, _args: string[] = [], deps?: Partial<MapPrepareDeps>): Promise<void> {
  const wire = new Wire(config);
  const actual: MapPrepareDeps = {
    requireGraphify,
    ensureUnitbobIgnored,
    runGraphifyExtractKeyless,
    extractRouteInventory,
    getRecipe: (name) => wire.getRecipe(name),
    listFeatures: () => wire.listFeatures(),
    stdout: process.stdout,
    stderr: process.stderr,
    ...deps,
  };

  actual.ensureUnitbobIgnored(config.projectRoot);

  // Said before the graph is built, because after it there is nothing left to
  // see: whatever these patterns matched never becomes a node, and a subsystem
  // that is missing from the map looks exactly like a subsystem that was never
  // written. One line per pattern that actually took something; a pattern that
  // matched nothing is not news (spec 35-1, criterion 1).
  const exclusions = ignoreExclusions(config.projectRoot);
  if (exclusions.length > 0) {
    actual.stdout.write(
      'Kept out of the graph by .graphifyignore — nothing below can appear on the map:\n' +
        exclusions.map((entry) => `  ${entry.pattern} — ${entry.files} file${entry.files === 1 ? '' : 's'}\n`).join(''),
    );
  }

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
  actual.stdout.write('Asking this project for the addresses it declares (this boots the application)…\n');
  const inventory = await actual.extractRouteInventory(config.projectRoot);

  const [decompose, relate, extractSurfaces, decomposeSurfaces, existing] = await Promise.all([
    actual.getRecipe('decompose'),
    actual.getRecipe('relate'),
    actual.getRecipe('extract_surfaces'),
    actual.getRecipe('decompose_surfaces'),
    existingCapabilities(actual),
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
    existing,
  );

  actual.stdout.write(`Map build request written to ${packet.project_root}/.unitbob/map-build/request.json\n`);
  actual.stdout.write(`${describeRouteInventory(inventory)}\n`);
  actual.stdout.write(
    `Next: build BOTH lenses following the recipes in that request — the decompose map at ` +
      `${packet.output_path} (recipes.decompose, recipes.relate), and the surface map at ` +
      `${packet.surface_output_path} (recipes.extract_surfaces → ${packet.surfaces_path}, then ` +
      'recipes.decompose_surfaces) — then run `unitbob put-map-build`.\n',
  );
}

// The capabilities finished features added to the map (spec 52-4, AC 5.1):
// by id, title and the intent as said — no addresses, the recipe matches by
// meaning. Only finished features: an open one is not on the map yet. A
// server older than the fields sends rows without a capability id, and one
// older than the route answers 404; both read as none, quietly, and the
// recipe skips its paragraph (AC 7.3). Any other failure of the list is not
// a reason to stop a map build either — but it is said, on stderr, because a
// map built without the finished features' ids is one that may redraw them.
async function existingCapabilities(d: MapPrepareDeps): Promise<ExistingCapability[]> {
  let features: FeatureListItem[];
  try {
    features = (await d.listFeatures()).features;
  } catch (err) {
    if (!(err instanceof WireError && err.status === 404)) {
      d.stderr.write(`Could not list finished features — the map is built without them: ${(err as Error).message}\n`);
    }
    return [];
  }
  return features
    .filter((feature) => feature.status === 'done' && typeof feature.capability_id === 'string')
    .map((feature) => ({ id: feature.capability_id!, title: feature.title, description: feature.intent ?? '' }));
}
