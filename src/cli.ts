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
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureLinked } from './link.ts';
import type { Config } from './config.ts';
import type { SuiteBuildResult } from './wire.ts';
import { recipe } from './verbs/recipe.ts';
import { show } from './verbs/show.ts';
import { run, runOnly } from './verbs/run.ts';
import { init } from './verbs/init.ts';
import { mapPrepare } from './verbs/mapPrepare.ts';
import { extractSurfaces } from './verbs/extractSurfaces.ts';
import { putMapBuild } from './verbs/putMapBuild.ts';
import { suitePrepare } from './verbs/suitePrepare.ts';
import { classifyPublication, putSuiteBuild } from './verbs/putSuiteBuild.ts';
import { validateBuild } from './verbs/validateBuild.ts';
import { fixPrepare } from './verbs/fixPrepare.ts';
import { contractPrompt } from './verbs/contractPrompt.ts';
import { suiteReviewPrepare } from './verbs/suiteReviewPrepare.ts';

const USAGE = `unitbob — thin local hands for the Unitbob server.

Usage: unitbob [--project-root <dir>] <verb> [args]

Options:
  --project-root <dir> Run against this project instead of the current folder.
                       Without it, an already-linked project is found by walking
                       up from where you are, so a subfolder works too.

Verbs:
  init                 Link this project to Unitbob (also happens automatically).
  recipe <name>        Fetch and print a recipe from the server.
  show                 Print the link to this project's map.
  map-prepare          Internal: keylessly update the graph (no API key) and write the host map-build request.
  extract-surfaces     Internal: write the addresses this project's own router declares, when the stack
                       can be asked for them. Says nothing when it cannot, which is a normal answer;
                       map-prepare runs it for you.
  put-map-build        Internal: upload the host-built map and graph.
  suite-prepare        Internal: fetch the recipe and capability assignment, write the host suite-build request.
  suite-review-prepare Internal: bind an independent BDD quality review to the built behavioral candidate.
  validate-build       Internal: check the host's suite answer against the request, locally, before
                       uploading. Reports every problem at once; put-suite-build runs it too.
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
  ensureLinked: (cwd?: string) => Promise<Config>;
}

export async function main(argv: string[], deps: CliDeps = { ensureLinked }): Promise<number> {
  const parsed = parseGlobalFlags(argv);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  const [verb, ...args] = parsed.rest;

  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return verb ? 0 : 1;
  }

  const linked = () => deps.ensureLinked(parsed.root);

  try {
    switch (verb) {
      case 'init':
        await init(args);
        return 0;
      case 'recipe':
        await recipe(await linked(), args);
        return 0;
      case 'show':
        await show(await linked());
        return 0;
      case 'map-prepare':
        await mapPrepare(await linked(), args);
        return 0;
      case 'extract-surfaces':
        await extractSurfaces(await linked(), args);
        return 0;
      case 'put-map-build':
        await putMapBuild(await linked(), args);
        return 0;
      case 'suite-prepare':
        await suitePrepare(await linked(), args);
        return 0;
      case 'suite-review-prepare':
        await suiteReviewPrepare(await linked(), args);
        return 0;
      case 'validate-build':
        await validateBuild(await linked(), args);
        return 0;
      case 'put-suite-build':
        return await publishAndRun(await linked(), args);
      case 'fix-prepare':
        await fixPrepare(await linked(), args);
        return 0;
      case 'contract-prompt':
        await contractPrompt(await linked(), args);
        return 0;
      case 'run':
      case 'check':
        await run(await linked(), args);
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

interface GlobalFlags {
  root?: string;
  rest: string[];
  error?: string;
}

// `--project-root` names the folder the verb runs in, for callers that cannot
// change directory — an agent driving the CLI from a scratch directory, a hook,
// a monorepo script. It is the explicit form of what `ensureLinked` already does
// by walking up, and it accepts the `project_root` a request packet prints, so
// the packet's own answer can be handed straight back.
//
// Parsed here rather than per verb: every verb resolves the same project, and a
// flag that means one thing for `check` and another for `suite-prepare` is worse
// than no flag.
function parseGlobalFlags(argv: string[]): GlobalFlags {
  const rest: string[] = [];
  let root: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === PROJECT_ROOT_FLAG) {
      root = argv[index + 1];
      index += 1;
    } else if (arg.startsWith(`${PROJECT_ROOT_FLAG}=`)) {
      root = arg.slice(PROJECT_ROOT_FLAG.length + 1);
    } else {
      rest.push(arg);
    }
    if (root !== undefined && !root) return { rest, error: `${PROJECT_ROOT_FLAG} requires a path.` };
  }

  if (root === undefined) return { rest };

  const resolved = resolve(root);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return { rest, error: `${PROJECT_ROOT_FLAG} ${root} is not a directory.` };
  }
  return { root: resolved, rest };
}

const PROJECT_ROOT_FLAG = '--project-root';

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
  // Resolved before the collaborators, so both halves of the command write to
  // the same stream. Injecting `stdout` has to capture everything the command
  // prints — publication lines and run summaries included — or a test can hold a
  // fraction of the output and read it as the whole of it.
  const stdout = deps?.stdout ?? process.stdout;
  const stderr = deps?.stderr ?? process.stderr;

  const d: PublishAndRunDeps = {
    putSuiteBuild: (cfg, a) => putSuiteBuild(cfg, a, { stdout }),
    runOnly: (cfg, digests) => runOnly(cfg, digests, { stdout }),
    stdout,
    stderr,
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
