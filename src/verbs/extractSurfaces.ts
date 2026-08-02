import type { Config } from '../config.ts';
import { ensureUnitbobIgnored } from '../proc.ts';
import { describeRouteInventory, extractRouteInventory } from '../surfaces/routeInventory.ts';

// Spec 32-7. `unitbob extract-surfaces` asks the framework's own router for the
// application's addresses and writes them down. It has the right to say nothing,
// and says nothing far more often than it speaks: only Rails can be asked today,
// and only when the application loads.
//
// Silence exits 0. Nothing is wrong when a stack has no router to ask — the
// map is still built, by the path that has always built it.
export async function extractSurfaces(config: Config, _args: string[] = []): Promise<void> {
  // Run on its own, this verb is the first thing to write into `.unitbob/`, so
  // it owes the project the same courtesy `map-prepare` does: the folder is our
  // bookkeeping and must not turn up in the vibecoder's commit.
  ensureUnitbobIgnored(config.projectRoot);

  const result = await extractRouteInventory(config.projectRoot);
  process.stdout.write(`${describeRouteInventory(result)}\n`);
}
