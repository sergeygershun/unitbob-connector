// `unitbob show` — print the link to this project's console on the server. The
// connector serves no UI of its own.
//
// The link goes through the exchanger and carries the token in its fragment
// (spec 33): the console answers 404 to a browser that has never proved it holds
// this project's key, and the fragment is the one part of a URL that never
// reaches the server's logs. There is no `#map` anchor any more — the map has an
// address of its own, and a URL only has room for one fragment, which the token
// now occupies.
import type { Config } from '../config.ts';
import { consoleUrl } from '../links.ts';

export function repoUrl(config: Config): string {
  return consoleUrl(config);
}

export async function show(config: Config): Promise<void> {
  process.stdout.write(`${repoUrl(config)}\n`);
}
