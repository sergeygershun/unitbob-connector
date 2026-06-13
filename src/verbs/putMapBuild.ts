import { readFileSync } from 'node:fs';
import type { Config } from '../config.ts';
import { readHostMapOutput, readMapBuildRequest } from '../files/mapBuild.ts';
import { Wire } from '../wire.ts';

interface PutMapBuildDeps {
  putMapBuild: (payload: { graph: unknown; map_document: unknown }) => Promise<{
    map_version_id: number;
    map_digest: string;
    graph_digest: string;
    map_url: string;
    reused: boolean;
  }>;
}

export async function putMapBuild(config: Config, _args: string[] = [], deps?: Partial<PutMapBuildDeps>): Promise<void> {
  const packet = readMapBuildRequest(config.projectRoot);
  const graph = JSON.parse(readFileSync(packet.graph_path, 'utf8'));
  const mapDocument = readHostMapOutput(packet.output_path);
  const actual: PutMapBuildDeps = {
    putMapBuild: (payload) => new Wire(config).putMapBuild(payload),
    ...deps,
  };

  const result = await actual.putMapBuild({ graph, map_document: mapDocument });
  process.stdout.write(
    `Map uploaded (${result.map_digest}, graph ${result.graph_digest}) ` +
      `${result.reused ? 'reused' : 'created'} version ${result.map_version_id}.\n` +
      `${result.map_url}\n`,
  );
}
