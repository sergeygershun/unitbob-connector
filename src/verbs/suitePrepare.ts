import type { Config } from '../config.ts';
import { materializeHelper } from '../files/guardrails.ts';
import { recipeNameFor, writeSuiteBuildRequest, type SuiteBuildBranch } from '../files/suiteBuild.ts';
import { anyStackPrecheck } from '../runner/precheck.ts';
import { Wire, type Recipe, type SuitePacket } from '../wire.ts';

interface SuitePrepareDeps {
  getRecipe: (name: string) => Promise<Recipe>;
  getSuitePacketsBatch: () => Promise<SuitePacket[]>;
  precheck: (projectRoot: string) => { ok: boolean; message?: string };
  stdout: { write: (chunk: string) => unknown };
}

// Confirm at least one supported stack is present, materialize the Ruby boot
// helper a generated RSpec suite would require, then fetch both peer assignments
// (spec 32) and each branch's recipe, and write the host's task to
// `.unitbob/suite-build/request.json`. No model is called and no source is read
// here — that is the host's job, framed by the two generation recipes. An
// unsupported project stops with one actionable message and writes nothing; a
// no-current-map error from the server surfaces (via WireError) with guidance to
// rebuild the map first.
export async function suitePrepare(config: Config, _args: string[] = [], deps?: Partial<SuitePrepareDeps>): Promise<void> {
  const wire = new Wire(config);
  const actual: SuitePrepareDeps = {
    getRecipe: (name) => wire.getRecipe(name),
    getSuitePacketsBatch: () => wire.getSuitePacketsBatch(),
    precheck: anyStackPrecheck,
    stdout: process.stdout,
    ...deps,
  };

  const check = actual.precheck(config.projectRoot);
  if (!check.ok) throw new Error(check.message ?? 'Unsupported runtime.');

  materializeHelper(config.projectRoot);

  const packets = await actual.getSuitePacketsBatch();
  const branches: SuiteBuildBranch[] = await Promise.all(
    packets.map(async (packet) => ({
      suite_kind: packet.suite_kind,
      source_digest: packet.source_digest,
      path_root: packet.path_root,
      recipe: await actual.getRecipe(recipeNameFor(packet)),
      assignment: packet.assignment,
    })),
  );

  const request = writeSuiteBuildRequest(config.projectRoot, branches);
  const kinds = branches.map((branch) => branch.suite_kind).join(' and ');

  actual.stdout.write(`Suite build request written to ${request.project_root}/.unitbob/suite-build/request.json\n`);
  actual.stdout.write(
    `Next: build both peer suites (${kinds}) following each branch's \`recipe\` and \`assignment\`, ` +
      `write your answer to ${request.output_path} as a branches array, run each locally to green, ` +
      'then run `unitbob put-suite-build`.\n',
  );
}
