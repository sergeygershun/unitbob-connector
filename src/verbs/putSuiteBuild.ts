import type { Config } from '../config.ts';
import { readHostSuiteOutput, readSuiteBuildRequest } from '../files/suiteBuild.ts';
import { Wire, type SuiteBuildUploadResult } from '../wire.ts';

interface PutSuiteBuildDeps {
  putSuiteBuild: (payload: { map_digest: string; blocks: unknown[] }) => Promise<SuiteBuildUploadResult>;
}

// Read the task and the host's answer, verify the answer parses, then upload
// `{ map_digest, blocks }`. `map_digest` comes from the task — never the host's
// answer file — so the host cannot claim a different map than it was given. If
// the answer is unparseable, nothing is uploaded and the previous suite stands.
export async function putSuiteBuild(config: Config, _args: string[] = [], deps?: Partial<PutSuiteBuildDeps>): Promise<void> {
  const request = readSuiteBuildRequest(config.projectRoot);
  const output = readHostSuiteOutput(request.output_path);
  const actual: PutSuiteBuildDeps = {
    putSuiteBuild: (payload) => new Wire(config).putSuiteBuild(payload),
    ...deps,
  };

  const result = await actual.putSuiteBuild({ map_digest: request.map_digest, blocks: output.blocks });

  const tallies = Object.entries(result.counts)
    .map(([name, value]) => `${value} ${name}`)
    .join(', ');
  process.stdout.write(
    `Suite uploaded (${result.suite_digest}) as version ${result.suite_version_id}` +
      `${tallies ? ` — ${tallies}` : ''}.\n${result.map_url}\n`,
  );
}
