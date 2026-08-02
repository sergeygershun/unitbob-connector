// Every link the connector prints for a human (spec 33).
//
// The repo page answers 404 without a cookie, and the browser only earns that
// cookie by handing over the project's token. So a printed link never points
// straight at the page: it goes through the exchanger, carries the token in the
// fragment, and names where the person was actually invited.
//
// The fragment is the point. Everything after `#` stays in the browser and
// never reaches the server, so it cannot land in the router log next to the
// path the way a query parameter would. It does not make the token a secret
// from the terminal — it is printed right here, and it sits in `.unitbob.json`
// — it keeps it out of the brain's logs.
import type { Config } from './config.ts';

// `destination` is where the person should end up: an absolute URL the server
// handed back (`map_url`), or a path. Only its path and query travel on; the
// server checks that it stays inside this project before honouring it.
export function enterUrl(config: Config, destination: string): string {
  const next = pathOf(destination) ?? `/repos/${config.repoId}`;
  const query = `?next=${encodeURIComponent(next)}`;
  return `${config.server}/repos/${config.repoId}/enter${query}#t=${config.token}`;
}

// The console, in a given tab.
export function consoleUrl(config: Config, tab?: 'structural' | 'behavioral'): string {
  const base = `/repos/${config.repoId}`;
  return enterUrl(config, tab ? `${base}?tab=${tab}` : base);
}

function pathOf(destination: string): string | null {
  if (destination.startsWith('/')) return destination;

  try {
    const url = new URL(destination);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
