import type { Config } from '../config.ts';
import { readHostSuiteOutput, readSuiteBuildRequest } from '../files/suiteBuild.ts';
import { Wire, type SuiteBuildUploadResult } from '../wire.ts';

interface PutSuiteBuildDeps {
  putSuiteBuild: (payload: {
    map_digest: string;
    spec_rb: string;
    test_metadata: unknown;
  }) => Promise<SuiteBuildUploadResult>;
}

// Read the task and the host's answer, verify the answer parses and carries the
// whole spec file + test_metadata, then upload `{ map_digest, spec_rb,
// test_metadata }`. `map_digest` comes from the task — never the host's answer —
// so the host cannot claim a different map than it was given. If the answer is
// unparseable or incomplete, nothing is uploaded and the previous suite stands.
export async function putSuiteBuild(config: Config, _args: string[] = [], deps?: Partial<PutSuiteBuildDeps>): Promise<void> {
  const request = readSuiteBuildRequest(config.projectRoot);
  const output = readHostSuiteOutput(request.output_path, config.projectRoot);
  const actual: PutSuiteBuildDeps = {
    putSuiteBuild: (payload) => new Wire(config).putSuiteBuild(payload),
    ...deps,
  };

  const result = await actual.putSuiteBuild({
    map_digest: request.map_digest,
    spec_rb: output.spec_rb,
    test_metadata: output.test_metadata,
  });

  const tallies = Object.entries(result.counts)
    .map(([name, value]) => `${value} ${name}`)
    .join(', ');
  process.stdout.write(
    `Suite uploaded (${result.suite_digest}) as version ${result.suite_version_id}` +
      `${tallies ? ` — ${tallies}` : ''}.\n${result.map_url}\n`,
  );
}
