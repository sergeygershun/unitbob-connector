#!/usr/bin/env node
// The single entry point. Parse `unitbob <verb> [args]`, dispatch to a hands-verb,
// and map any thrown error to a non-zero exit with an actionable message — never
// a raw stack trace. This is the only place that decides process exit codes.
import { loadConfig } from './config.ts';
import { recipe } from './verbs/recipe.ts';
import { show } from './verbs/show.ts';
import { map } from './verbs/map.ts';
import { run } from './verbs/run.ts';
import { init } from './verbs/init.ts';

const USAGE = `unitbob — thin local hands for the Unitbob server.

Usage: unitbob <verb> [args]

Verbs:
  init                 Write a .unitbob.json template and git-ignore it.
  recipe <name>        Fetch and print a recipe from the server.
  show                 Print the link to this project's map.
  map                  Extract the code graph and upload it. Full map build lands in spec 19.
  run                  Run the guardrail suite and report.     (spec 18)

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
      case 'map':
        await map(loadConfig(), args);
        return 0;
      case 'run':
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
