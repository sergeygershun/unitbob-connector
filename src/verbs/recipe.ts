// `unitbob recipe <name>` — fetch a recipe from the server and print it. Real
// now. The connector holds no recipe text of its own; improving a recipe is a
// server-side change only (spec 15, acceptance criteria).
import type { Config } from '../config.ts';
import { Wire } from '../wire.ts';

export async function recipe(config: Config, args: string[]): Promise<void> {
  const name = args[0];
  if (!name) {
    throw new Error('usage: unitbob recipe <name>  (e.g. decompose, relate, generate)');
  }
  const { text } = await new Wire(config).getRecipe(name);
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}
