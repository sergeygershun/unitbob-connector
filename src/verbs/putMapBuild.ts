import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import {
  readHostMapOutput,
  readMapBuildRequest,
  readSurfaceDocument,
  readSurfacesInventory,
} from '../files/mapBuild.ts';
import { inventoryProblems } from '../surfaces/routeInventory.ts';
import { Wire } from '../wire.ts';

interface PutMapBuildDeps {
  putMapBuild: (payload: {
    graph: unknown;
    map_document: unknown;
    surfaces: unknown;
    surface_document: unknown;
  }) => Promise<{
    map_version_id: number;
    map_digest: string;
    surface_digest: string;
    graph_digest: string;
    map_url: string;
    reused: boolean;
  }>;
}

export async function putMapBuild(config: Config, _args: string[] = [], deps?: Partial<PutMapBuildDeps>): Promise<void> {
  const packet = readMapBuildRequest(config.projectRoot);
  const graph = JSON.parse(readFileSync(packet.graph_path, 'utf8'));
  // Both lenses must be present locally before anything is sent — the host stores
  // the bundle atomically or not at all (spec 31). A missing artifact here throws
  // and no partial upload happens.
  const mapDocument = readHostMapOutput(packet.output_path);
  const surfaces = readSurfacesInventory(packet.surfaces_path);
  const surfaceDocument = readSurfaceDocument(packet.surface_output_path);
  refuseAlteredAddresses(packet.route_inventory_path, surfaces);
  refuseSurfacesWithoutStorage(config.projectRoot, surfaces);
  const actual: PutMapBuildDeps = {
    putMapBuild: (payload) => new Wire(config).putMapBuild(payload),
    ...deps,
  };

  const result = await actual.putMapBuild({
    graph,
    map_document: mapDocument,
    surfaces,
    surface_document: surfaceDocument,
  });
  process.stdout.write(
    `Map uploaded (map ${result.map_digest}, surface ${result.surface_digest}, graph ${result.graph_digest}) ` +
      `${result.reused ? 'reused' : 'created'} version ${result.map_version_id}.\n` +
      `${result.map_url}\n`,
  );
}

// Spec 32-7. Where the router could be asked, the addresses are a fact, and the
// only thing standing between that fact and the map was an instruction in a
// prompt — the same kind of instruction that already said "never spell an id
// yourself" while a2time's map grew an address no router had. So the two files
// are compared here, where both are still on this machine, and a mismatch stops
// the upload with the ids named.
//
// This decides nothing about the map: it does not group, rank or judge a single
// surface. It compares the answer with the request, which is the line spec 32-6
// drew for `validate-build`, and refuses to send an answer that contradicts a
// fact we already hold.
function refuseAlteredAddresses(inventoryPath: string | undefined, surfaces: unknown): void {
  if (!inventoryPath) return; // no router was asked; there is nothing to hold the answer to

  if (!existsSync(inventoryPath)) {
    throw new Error(
      `${inventoryPath} is named by the build request but is not there. Run \`unitbob map-prepare\` ` +
        'again so the addresses come from the router, then rebuild the surface map.',
    );
  }

  let inventory: unknown = null;
  try {
    inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  } catch {
    inventory = null; // unreadable is itself a problem, and reads as one below
  }

  const problems = inventoryProblems(inventory, surfaces);
  if (problems.length === 0) return;

  throw new Error(
    `The routes in surfaces.json do not match the ones this project's router declared, so nothing ` +
      `was uploaded and the previous map stays current:\n- ${problems.join('\n- ')}`,
  );
}

// Spec 32-7, Task 1.11. The addresses are now a command's answer rather than the
// model's, and the recipe turns that answer into `surfaces.json` with one line
// of `node -e`. Ten seconds in, the file is full of routes and looks like a
// finished inventory — and the surfaces no router declares (`table`, `job`,
// `external`) are found only if the model keeps reading after that point.
//
// The spec spent five rounds establishing that "the prompt says so" is not a
// guarantee, then left exactly this one resting on it. So the cheapest half is
// checked here: a project that keeps a schema on disk and reports not a single
// table did not finish the file. Jobs and externals a project may genuinely not
// have, and no honest check exists for them; tables it either stores or does not.
//
// A refusal, not a warning — the same standing as an altered address above, and
// for the same reason: an inventory missing every table sails through the rest
// of the pipeline agreeing with itself.
function refuseSurfacesWithoutStorage(projectRoot: string, surfaces: unknown): void {
  const schema = ['db/schema.rb', 'db/structure.sql'].find((file) =>
    existsSync(join(projectRoot, ...file.split('/'))),
  );
  if (!schema) return; // nothing on disk says this project stores anything

  const list = (surfaces as { surfaces?: unknown } | null)?.surfaces;
  if (!Array.isArray(list)) return; // shape is the host's complaint to make, not ours
  if (list.some((surface) => (surface as { kind?: unknown } | null)?.kind === 'table')) return;

  throw new Error(
    `surfaces.json declares no \`table\` surface, but this project has ${schema}, so nothing was ` +
      'uploaded and the previous map stays current. The routes are only one of the four kinds: read ' +
      'the schema for `table` surfaces, and the source for `job` and `external` ones, then run ' +
      '`unitbob put-map-build` again.',
  );
}
