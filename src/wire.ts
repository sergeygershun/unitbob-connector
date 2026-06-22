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
import type { SuiteBlob } from './files/guardrails.ts';

export interface Recipe {
  name: string;
  version: string;
  text: string;
}

export interface RunSummary {
  summary: string;
  map_url: string;
  lamps: unknown;
}

export interface MapBuildUploadResult {
  map_version_id: number;
  map_digest: string;
  graph_digest: string;
  map_url: string;
  reused: boolean;
}

// The host's assignment: per block, the capabilities (interfaces) to guard, cut
// from the current map. The connector relays it down to the host untouched —
// `blocks` is an opaque list it never reads into.
export interface SuitePackets {
  map_digest: string;
  blocks: unknown[];
}

export interface SuiteBuildUploadResult {
  suite_version_id: number;
  suite_digest: string;
  map_url: string;
  // The server-computed tallies, printed verbatim. Kept as a loose map so the
  // connector names none of the server's domain buckets.
  counts: Record<string, number>;
}

// The per-capability repair data packet (spec 26). Carries no source and no test
// body — the host reads its own checkout and the whole local spec file. The
// connector relays the packet down and prints `message`.
export interface FixPacket {
  interface_id: string;
  headline: string;
  failure_message: string;
  anchor: string | null;
  message: string;
}

// Raised when the server cannot be reached or answers with an error status.
// Verbs surface its message and exit non-zero; they never fabricate a result.
export class WireError extends Error {}

export class Wire {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  // PUT /repos/:id/map_build — upload the fresh graph and host-built map as one
  // atomic blob. Rails validates, versions, and computes all digests.
  async putMapBuild(payload: { graph: unknown; map_document: unknown }): Promise<MapBuildUploadResult> {
    const res = await this.send('PUT', this.repoPath('map_build'), payload);
    await this.ensureOk(res, `PUT ${this.repoPath('map_build')}`);
    return (await res.json()) as MapBuildUploadResult;
  }

  // GET /repos/:id/suite_packets — the host's assignment (the capabilities to
  // guard). Relayed opaque; 409 (no current map) surfaces as a WireError carrying
  // the server's "run /unitbob map first" guidance.
  async getSuitePackets(): Promise<SuitePackets> {
    const res = await this.send('GET', this.repoPath('suite_packets'));
    await this.ensureOk(res, `GET ${this.repoPath('suite_packets')}`);
    return (await res.json()) as SuitePackets;
  }

  // PUT /repos/:id/suite_build — upload the host's complete, locally-validated
  // suite: the verbatim spec file plus the capability-keyed test_metadata. The
  // server validates the classification, stores the bytes verbatim, versions, and
  // returns the new suite's identity.
  async putSuiteBuild(payload: {
    map_digest: string;
    spec_rb: string;
    test_metadata: unknown;
  }): Promise<SuiteBuildUploadResult> {
    const res = await this.send('PUT', this.repoPath('suite_build'), payload);
    await this.ensureOk(res, `PUT ${this.repoPath('suite_build')}`);
    return (await res.json()) as SuiteBuildUploadResult;
  }

  // GET /repos/:id/fix_packet?interface_id= — the per-capability repair packet.
  // Relayed down for the host to fix code or accept the change; 422 (non-failed /
  // stale / no suite) surfaces as a WireError carrying the server's business reason.
  async getFixPacket(interfaceId: string): Promise<FixPacket> {
    const url = this.repoQueryPath('fix_packet', 'interface_id', interfaceId);
    const res = await this.send('GET', url);
    await this.ensureOk(res, `GET ${url}`);
    return (await res.json()) as FixPacket;
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
  async getSuite(): Promise<SuiteBlob | null> {
    const res = await this.send('GET', this.repoPath('suite'));
    if (res.status === 204) return null;
    await this.ensureOk(res, `GET ${this.repoPath('suite')}`);
    return this.decodeSuiteBlob(await res.json());
  }

  // POST /repos/:id/runs — ship the raw runner output; the server parses it and
  // returns the run summary. The connector neither builds nor reads the payload
  // body beyond passing it along.
  async postRun(payload: unknown): Promise<RunSummary> {
    const res = await this.send('POST', this.repoPath('runs'), payload);
    await this.ensureOk(res, `POST ${this.repoPath('runs')}`);
    return (await res.json()) as RunSummary;
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

  private repoQueryPath(suffix: string, key: string, value: string): string {
    return `${this.repoPath(suffix)}?${key}=${encodeURIComponent(value)}`;
  }

  private decodeSuiteBlob(payload: unknown): SuiteBlob {
    if (!payload || typeof payload !== 'object') {
      throw new WireError(`GET ${this.repoPath('suite')} returned a malformed suite payload.`);
    }

    const suite = payload as Record<string, unknown>;
    if (typeof suite.suite_digest !== 'string' || typeof suite.spec_rb !== 'string') {
      throw new WireError(
        `GET ${this.repoPath('suite')} returned a malformed suite payload: ` +
          'expected suite_digest and spec_rb.',
      );
    }

    return suite as unknown as SuiteBlob;
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
