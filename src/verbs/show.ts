// `unitbob show` — print the link to this project's repo page on the server. The
// connector serves no UI of its own. We point at the human repo page `/repos/:id`
// where the run status renders, not the map document JSON at `/repos/:id/map` — the
// JSON is the machine view, the page is the view a user actually wants (spec 24).
import type { Config } from '../config.ts';

export function repoUrl(config: Config): string {
  return `${config.server}/repos/${config.repoId}`;
}

export async function show(config: Config): Promise<void> {
  process.stdout.write(`${repoUrl(config)}\n`);
}
