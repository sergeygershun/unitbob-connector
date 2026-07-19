import type { Config } from '../config.ts';
import { materializeHelper } from '../files/guardrails.ts';
import { writeSuiteBuildRequest } from '../files/suiteBuild.ts';
import { anyStackPrecheck } from '../runner/precheck.ts';
import { Wire, type Recipe, type SuitePackets } from '../wire.ts';

interface SuitePrepareDeps {
  getRecipe: (name: string) => Promise<Recipe>;
  getSuitePackets: () => Promise<SuitePackets>;
  precheck: (projectRoot: string) => { ok: boolean; message?: string };
}

// Confirm at least one supported stack is present (Rails+RSpec, Vitest, or
// pytest — the host LLM picks the primary one during generation), materialize
// the Ruby boot helper a generated RSpec suite would require, then fetch the
// generate recipe and the per-block capability assignment and write the host's
// task to `.unitbob/suite-build/request.json`. No model is called and no
// source is read here — that is the host's job, framed by
// ai/agents/suite_builder.md. An unsupported project stops with one actionable
// message and writes nothing; a no-current-map error from the server surfaces
// (via WireError) with guidance to run `/unitbob map` first.
export async function suitePrepare(config: Config, _args: string[] = [], deps?: Partial<SuitePrepareDeps>): Promise<void> {
  const wire = new Wire(config);
  const actual: SuitePrepareDeps = {
    getRecipe: (name) => wire.getRecipe(name),
    getSuitePackets: () => wire.getSuitePackets(),
    precheck: anyStackPrecheck,
    ...deps,
  };

  const check = actual.precheck(config.projectRoot);
  if (!check.ok) throw new Error(check.message ?? 'Unsupported runtime.');

  materializeHelper(config.projectRoot);

  const [recipe, packets] = await Promise.all([actual.getRecipe('generate'), actual.getSuitePackets()]);
  const request = writeSuiteBuildRequest(config.projectRoot, {
    map_digest: packets.map_digest,
    recipe,
    blocks: packets.blocks,
  });

  process.stdout.write(`Suite build request written to ${request.project_root}/.unitbob/suite-build/request.json\n`);
  process.stdout.write(
    `Next: write the complete guardrail spec and ${request.output_path} following \`recipe\` and the ` +
      'per-block capability `blocks` inside that request, run it locally to green, then run `unitbob put-suite-build`.\n',
  );
}
