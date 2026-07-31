// Verb dispatch. Parse `unitbob <verb> [args]`, dispatch to a hands-verb, and map
// any thrown error to an exit code with an actionable message — never a raw stack
// trace. This module decides exit codes but never acts on them: importing it must
// stay free of side effects so tests can drive `main` directly. `bin.ts` is the
// executable that owns process startup and exit.
//
// One verb is more than a dispatch: `put-suite-build` composes two hands-verbs
// into a single user operation, so `publishAndRun` at the bottom of this file
// holds that sequence and the exit code it implies (spec 32-4). Every other verb
// keeps its whole flow in its own module under `verbs/`.
import { ensureLinked } from './link.ts';
import type { Config } from './config.ts';
import type { SuiteBuildResult } from './wire.ts';
import { recipe } from './verbs/recipe.ts';
import { show } from './verbs/show.ts';
import { run, runOnly } from './verbs/run.ts';
import { init } from './verbs/init.ts';
import { mapPrepare } from './verbs/mapPrepare.ts';
import { putMapBuild } from './verbs/putMapBuild.ts';
import { suitePrepare } from './verbs/suitePrepare.ts';
import { classifyPublication, putSuiteBuild } from './verbs/putSuiteBuild.ts';
import { fixPrepare } from './verbs/fixPrepare.ts';
import { contractPrompt } from './verbs/contractPrompt.ts';
import { suiteReviewPrepare } from './verbs/suiteReviewPrepare.ts';

const USAGE = `unitbob — thin local hands for the Unitbob server.

Usage: unitbob <verb> [args]

Verbs:
  init                 Link this project to Unitbob (also happens automatically).
  recipe <name>        Fetch and print a recipe from the server.
  show                 Print the link to this project's map.
  map-prepare          Internal: keylessly update the graph (no API key) and write the host map-build request.
  put-map-build        Internal: upload the host-built map and graph.
  suite-prepare        Internal: fetch the recipe and capability assignment, write the host suite-build request.
  suite-review-prepare Internal: bind an independent BDD quality review to the built behavioral candidate.
  put-suite-build      Internal: upload the host-built guardrail suite (whole spec file + test_metadata),
                       then run every branch it published and report the server's results.
  fix-prepare <id>     Internal: fetch the per-capability repair packet for one red guard (by interface_id).
  contract-prompt <digest> <test_id> [fix|accept]
                       Internal: fetch the fix/accept brief for one red check on either map.
  check                Run every Unitbob contract suite locally and report.
  run                  Alias for check.

Pipeline: map and suite are built on your machine. \`*-prepare\` writes a request
packet (with the recipe and paths); you build the artifact at the packet's
output_path from your local source; \`put-*\` uploads only the structured result.
\`put-suite-build\` then runs what it published, so a suite never sits with nothing
to show. \`check\` re-runs the guardrails locally and reports results to the server.
Graph extraction is keyless: the connector needs no LLM API key. Inference is the
host-LLM's job; any semantic graph enrichment is host-LLM work (the /graphify skill).

Config: .unitbob.json at your project root, created automatically: the first
run registers the project on the server by its folder name (spec 28).`;

interface CliDeps {
  ensureLinked: () => Promise<Config>;
}

export async function main(argv: string[], deps: CliDeps = { ensureLinked }): Promise<number> {
  const [verb, ...args] = argv;

  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return verb ? 0 : 1;
  }

  try {
    switch (verb) {
      case 'init':
        await init(args);
        return 0;
      case 'recipe':
        await recipe(await deps.ensureLinked(), args);
        return 0;
      case 'show':
        await show(await deps.ensureLinked());
        return 0;
      case 'map-prepare':
        await mapPrepare(await deps.ensureLinked(), args);
        return 0;
      case 'put-map-build':
        await putMapBuild(await deps.ensureLinked(), args);
        return 0;
      case 'suite-prepare':
        await suitePrepare(await deps.ensureLinked(), args);
        return 0;
      case 'suite-review-prepare':
        await suiteReviewPrepare(await deps.ensureLinked(), args);
        return 0;
      case 'put-suite-build':
        return await publishAndRun(await deps.ensureLinked(), args);
      case 'fix-prepare':
        await fixPrepare(await deps.ensureLinked(), args);
        return 0;
      case 'contract-prompt':
        await contractPrompt(await deps.ensureLinked(), args);
        return 0;
      case 'run':
      case 'check':
        await run(await deps.ensureLinked(), args);
        return 0;
      default:
        process.stderr.write(`Unknown verb "${verb}".\n\n${USAGE}\n`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

interface PublishAndRunDeps {
  putSuiteBuild: (config: Config, args: string[]) => Promise<SuiteBuildResult[]>;
  runOnly: (config: Config, digests: string[]) => Promise<void>;
  stdout: { write: (chunk: string) => unknown };
  stderr: { write: (chunk: string) => unknown };
}

// Publishing a suite and running it the first time are one user operation
// (spec 32-4). They used to be two commands, and the second one was a step the
// host LLM could simply not take: the suite was stored, nothing had ever run it,
// and the user was told about results that did not exist. Now the connector owns
// the sequence, so no instruction-following can drop half of it.
//
// This is a composition, not a transaction. The two server requests stay separate:
// if the run cannot finish, the published suite and any earlier results for the
// same identity survive untouched, and a standalone `unitbob check` completes the
// loop. The two outputs also keep separate authorities — which branch published
// comes from the build response, and what the results are comes only from the
// server's answer to the run.
export async function publishAndRun(
  config: Config,
  args: string[],
  deps?: Partial<PublishAndRunDeps>,
): Promise<number> {
  const d: PublishAndRunDeps = {
    putSuiteBuild: (cfg, a) => putSuiteBuild(cfg, a),
    runOnly: (cfg, digests) => runOnly(cfg, digests),
    stdout: process.stdout,
    stderr: process.stderr,
    ...deps,
  };

  const { digests, unpublished } = classifyPublication(await d.putSuiteBuild(config, args));

  // Nothing is current, so there is nothing honest to run. A branch that failed
  // to publish must never fall back to the suite it was meant to replace.
  if (digests.length === 0) {
    d.stderr.write('No suite was published, so nothing was run. Fix the problems reported above and generate the Unitbob guardrails again.\n');
    return 1;
  }

  // Said between the two halves, because it is a fact about publication and the
  // run summaries have not been printed yet. Reading a peer's results onto a
  // branch that was never published is the exact mistake this whole spec exists
  // to stop, so the output names the gap instead of leaving it to be inferred.
  if (unpublished.length > 0) {
    d.stdout.write(`Partial success. No run summary below covers: ${unpublished.join(', ')}.\n`);
  }

  try {
    await d.runOnly(config, digests);
  } catch (err) {
    // The upload never happened, so no results were stored — partially or
    // otherwise. Everything published above is still valid and still current.
    d.stderr.write(`${(err as Error).message}\nThe suite is published. Run the Unitbob checks to finish.\n`);
    return 1;
  }

  return 0;
}
