// The wire: a thin HTTP client over the Connector ↔ Rails protocol (spec 14).
// It is the connector's only door to the brain. It transfers opaque blobs —
// graph, recipe, suite, run output, the run summary the server returns — and
// never inspects their contents. Every payload below is typed as `unknown`
// precisely because reading into it would be domain logic, which belongs on
// Rails (see ../test/architecture.test.ts).
//
// This is the one file allowed to name the `/lamps` endpoint, because here
// "lamps" is just the URL of a blob the connector fetches and prints verbatim —
// not something it reasons about.
import type { Config } from './config.ts';

export interface Recipe {
  name: string;
  version: string;
  text: string;
}

// Raised when the server cannot be reached or answers with an error status.
// Verbs surface its message and exit non-zero; they never fabricate a result.
export class WireError extends Error {}

export class Wire {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  // PUT /repos/:id/graph — upload the graphify extract, get its digest back.
  async putGraph(graph: unknown): Promise<{ graph_digest: string }> {
    const res = await this.send('PUT', this.repoPath('graph'), graph);
    await this.ensureOk(res, `PUT ${this.repoPath('graph')}`);
    return (await res.json()) as { graph_digest: string };
  }

  // GET /recipes/:name — fetch a recipe at call time. Recipes live on Rails so
  // the connector and Skill carry no recipe text (spec 15, acceptance criteria).
  async getRecipe(name: string): Promise<Recipe> {
    const url = `${this.config.server}/recipes/${encodeURIComponent(name)}`;
    const res = await this.send('GET', url);
    if (res.status === 404) {
      throw new WireError(`Unknown recipe "${name}" (server returned 404).`);
    }
    await this.ensureOk(res, `GET ${url}`);
    return (await res.json()) as Recipe;
  }

  // GET /repos/:id/suite — the current suite blob, or null when none exists yet
  // (the server answers 204). Returned opaque; materializing it is spec 18.
  async getSuite(): Promise<unknown | null> {
    const res = await this.send('GET', this.repoPath('suite'));
    if (res.status === 204) return null;
    await this.ensureOk(res, `GET ${this.repoPath('suite')}`);
    return await res.json();
  }

  // POST /repos/:id/runs — ship the raw runner output; the server parses it and
  // returns the run summary. The connector neither builds nor reads the payload
  // body beyond passing it along.
  async postRun(payload: unknown): Promise<unknown> {
    const res = await this.send('POST', this.repoPath('runs'), payload);
    await this.ensureOk(res, `POST ${this.repoPath('runs')}`);
    return await res.json();
  }

  // GET /repos/:id/lamps — the server's current run summary, printed verbatim.
  async getLamps(): Promise<unknown> {
    const res = await this.send('GET', this.repoPath('lamps'));
    await this.ensureOk(res, `GET ${this.repoPath('lamps')}`);
    return await res.json();
  }

  private repoPath(suffix: string): string {
    return `${this.config.server}/repos/${this.config.repoId}/${suffix}`;
  }

  private async send(method: string, url: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new WireError(
        `Cannot reach the Unitbob server at ${this.config.server} ` +
          `(${(err as Error).message}). Check that the server is running and that ` +
          `"server" in .unitbob.json is correct.`,
      );
    }
  }

  private async ensureOk(res: Response, what: string): Promise<void> {
    if (res.ok) return;
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      // ignore — the status alone is actionable enough
    }
    throw new WireError(`${what} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
}
