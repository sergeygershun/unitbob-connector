// `unitbob show` — print the link to this project's map on the server. Real now.
// The connector serves no UI of its own; the map is viewed on Rails.
import type { Config } from '../config.ts';

export function mapUrl(config: Config): string {
  return `${config.server}/repos/${config.repoId}/map`;
}

export async function show(config: Config): Promise<void> {
  process.stdout.write(`${mapUrl(config)}\n`);
}
