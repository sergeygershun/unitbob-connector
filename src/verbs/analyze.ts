// `unitbob analyze` — will run graphify locally and PUT the graph to the server.
// Wired entry point in the skeleton; the capability body lands in spec 17
// (Graphify on Connector). Prints a clear "not yet" message rather than
// fabricating a result.
import type { Config } from '../config.ts';

export async function analyze(_config: Config, _args: string[]): Promise<void> {
  process.stdout.write(
    'unitbob analyze: not implemented yet — arrives in spec 17 (Graphify on Connector).\n',
  );
}
