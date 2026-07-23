import { readFileSync } from 'node:fs';
import type { Config } from '../config.ts';
import {
  readHostMapOutput,
  readMapBuildRequest,
  readSurfaceDocument,
  readSurfacesInventory,
} from '../files/mapBuild.ts';
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
