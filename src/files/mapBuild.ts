import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Recipe } from '../wire.ts';

export interface MapBuildRequest {
  project_root: string;
  graph_path: string;
  output_path: string;
  surfaces_path: string;
  surface_output_path: string;
  recipes: {
    decompose: Recipe;
    relate: Recipe;
    extract_surfaces: Recipe;
    decompose_surfaces: Recipe;
  };
}

export type MapBuildRecipes = MapBuildRequest['recipes'];

export function graphPath(projectRoot: string): string {
  // The one canonical local graph, shared with Graphify and any host-LLM
  // enrichment. The connector keeps no second `.unitbob` copy.
  return join(projectRoot, 'graphify-out', 'graph.json');
}

export function requestPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'map-build', 'request.json');
}

export function outputPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'map-build', 'map_document.json');
}

// The surface inventory (spec 31, step 1) and the grouped surface document
// (step 2) are the two extra local artifacts of one atomic map build.
export function surfacesPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'map-build', 'surfaces.json');
}

export function surfaceOutputPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'map-build', 'surface_document.json');
}

export function readFreshGraph(projectRoot: string): string {
  const path = graphPath(projectRoot);
  if (!existsSync(path)) {
    throw new Error(`graphify update did not write ${path}`);
  }

  const rawGraphJson = readFileSync(path, 'utf8');
  parseJson(rawGraphJson, path);
  return rawGraphJson;
}

export function writeMapBuildRequest(projectRoot: string, recipes: MapBuildRecipes): MapBuildRequest {
  const packet: MapBuildRequest = {
    project_root: projectRoot,
    graph_path: graphPath(projectRoot),
    output_path: outputPath(projectRoot),
    surfaces_path: surfacesPath(projectRoot),
    surface_output_path: surfaceOutputPath(projectRoot),
    recipes,
  };

  const path = requestPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`);
  return packet;
}

export function readMapBuildRequest(projectRoot: string): MapBuildRequest {
  const path = requestPath(projectRoot);
  if (!existsSync(path)) {
    throw new Error(`${path} not found — run \`npx unitbob map-prepare\` first.`);
  }

  const packet = parseJson(readFileSync(path, 'utf8'), path);
  if (!isMapBuildRequest(packet)) {
    throw new Error(
      `${path} is malformed: expected project_root, graph_path, output_path, surfaces_path, ` +
        'surface_output_path, and recipes.',
    );
  }

  return packet;
}

export function readHostMapOutput(path: string): unknown {
  if (!existsSync(path)) {
    throw new Error(`${path} not found — the host map builder did not write a map document.`);
  }

  return parseJson(readFileSync(path, 'utf8'), path);
}

// The two surface artifacts are both required before upload: no partial bundle
// carrying only one lens is ever sent (spec 31, atomic bundle).
export function readSurfacesInventory(path: string): unknown {
  if (!existsSync(path)) {
    throw new Error(`${path} not found — the extract_surfaces step did not write a surfaces inventory.`);
  }

  return parseJson(readFileSync(path, 'utf8'), path);
}

export function readSurfaceDocument(path: string): unknown {
  if (!existsSync(path)) {
    throw new Error(`${path} not found — the decompose_surfaces step did not write a surface document.`);
  }

  return parseJson(readFileSync(path, 'utf8'), path);
}

function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message})`);
  }
}

function isMapBuildRequest(value: unknown): value is MapBuildRequest {
  if (!value || typeof value !== 'object') return false;
  const packet = value as Record<string, unknown>;
  const recipes = packet.recipes as Record<string, unknown> | undefined;
  return (
    typeof packet.project_root === 'string' &&
    typeof packet.graph_path === 'string' &&
    typeof packet.output_path === 'string' &&
    typeof packet.surfaces_path === 'string' &&
    typeof packet.surface_output_path === 'string' &&
    !!recipes &&
    isRecipe(recipes.decompose) &&
    isRecipe(recipes.relate) &&
    isRecipe(recipes.extract_surfaces) &&
    isRecipe(recipes.decompose_surfaces)
  );
}

function isRecipe(value: unknown): value is Recipe {
  if (!value || typeof value !== 'object') return false;
  const recipe = value as Record<string, unknown>;
  return typeof recipe.name === 'string' && typeof recipe.version === 'string' && typeof recipe.text === 'string';
}
