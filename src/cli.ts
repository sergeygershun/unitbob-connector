#!/usr/bin/env node
// The single entry point. Parse `unitbob <verb> [args]`, dispatch to a hands-verb,
// and map any thrown error to a non-zero exit with an actionable message — never
// a raw stack trace. This is the only place that decides process exit codes.
import { loadConfig } from './config.ts';
import { recipe } from './verbs/recipe.ts';
import { show } from './verbs/show.ts';
import { run } from './verbs/run.ts';
import { init } from './verbs/init.ts';
import { mapPrepare } from './verbs/mapPrepare.ts';
import { putMapBuild } from './verbs/putMapBuild.ts';
import { suitePrepare } from './verbs/suitePrepare.ts';
import { putSuiteBuild } from './verbs/putSuiteBuild.ts';
import { fixPrepare } from './verbs/fixPrepare.ts';

const USAGE = `unitbob — thin local hands for the Unitbob server.

Usage: unitbob <verb> [args]

Verbs:
  init                 Write a .unitbob.json template and git-ignore it.
  recipe <name>        Fetch and print a recipe from the server.
  show                 Print the link to this project's map.
  map-prepare          Internal: keylessly update the graph (no API key) and write the host map-build request.
  put-map-build        Internal: upload the host-built map and graph.
  suite-prepare        Internal: fetch the recipe and capability assignment, write the host suite-build request.
  put-suite-build      Internal: upload the host-built guardrail suite (whole spec file + test_metadata).
  fix-prepare <id>     Internal: fetch the per-capability repair packet for one red guard (by interface_id).
  check                Run the guardrail suite locally and report.
  run                  Alias for check.

Pipeline: map and suite are built on your machine. \`*-prepare\` writes a request
packet (with the recipe and paths); you build the artifact at the packet's
output_path from your local source; \`put-*\` uploads only the structured result.
\`check\` runs the guardrails locally and reports results to the server.
Graph extraction is keyless: the connector needs no LLM API key. Inference is the
host-LLM's job; any semantic graph enrichment is host-LLM work (the /graphify skill).

Config: .unitbob.json at your project root — { "server": "...", "repo_id": <number> }.`;

async function main(argv: string[]): Promise<number> {
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
        await recipe(loadConfig(), args);
        return 0;
      case 'show':
        await show(loadConfig());
        return 0;
      case 'map-prepare':
        await mapPrepare(loadConfig(), args);
        return 0;
      case 'put-map-build':
        await putMapBuild(loadConfig(), args);
        return 0;
      case 'suite-prepare':
        await suitePrepare(loadConfig(), args);
        return 0;
      case 'put-suite-build':
        await putSuiteBuild(loadConfig(), args);
        return 0;
      case 'fix-prepare':
        await fixPrepare(loadConfig(), args);
        return 0;
      case 'run':
      case 'check':
        await run(loadConfig(), args);
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

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  },
);
