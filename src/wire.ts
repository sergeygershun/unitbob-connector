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

// The per-block packets the server cuts from the current map. The connector
// relays them down to the host untouched — `packets` is an opaque list it never
// reads into.
export interface SuitePackets {
  map_digest: string;
  packets: unknown[];
}

export interface SuiteBuildUploadResult {
  suite_version_id: number;
  suite_digest: string;
  map_url: string;
  // The server-computed tallies, printed verbatim. Kept as a loose map so the
  // connector names none of the server's domain buckets.
  counts: Record<string, number>;
}

// The per-test Fix data packet (spec 21). Carries no source — the host reads its
// own checkout; the connector relays the packet down and prints `message`.
export interface FixPacket {
  headline: string;
  test_body: string;
  failure_message: string;
  anchor: string | null;
  message: string;
}

// The reshape task the host regenerates one body from (spec 21): the bundled
// generate recipe, a single-element packet (opaque to the connector), and the
// current suite_digest the host must echo back.
export interface ReshapePacket {
  recipe: Recipe;
  packet: unknown;
  suite_digest: string;
}

// The Rails-assembled candidate the connector runs as the local gate. Rails owns
// the suite header; `red_message` is the business string to print if the gate is
// red. Nothing is committed yet.
export interface ReshapeCandidateResult {
  candidate_spec: string;
  red_message: string;
}

// The committed reshape (a new versioned snapshot). `message` is printed verbatim.
export interface ReshapeCommitResult {
  suite_version_id: number;
  suite_digest: string;
  map_url: string;
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

  // GET /repos/:id/suite_packets — the per-block packets the host writes the
  // suite from. Relayed opaque; 409 (no current map) surfaces as a WireError
  // carrying the server's "run /unitbob map first" guidance.
  async getSuitePackets(): Promise<SuitePackets> {
    const res = await this.send('GET', this.repoPath('suite_packets'));
    await this.ensureOk(res, `GET ${this.repoPath('suite_packets')}`);
    return (await res.json()) as SuitePackets;
  }

  // PUT /repos/:id/suite_build — upload the host's structured suite output. The
  // server validates, assembles, versions, and returns the new suite's identity.
  async putSuiteBuild(payload: { map_digest: string; blocks: unknown[] }): Promise<SuiteBuildUploadResult> {
    const res = await this.send('PUT', this.repoPath('suite_build'), payload);
    await this.ensureOk(res, `PUT ${this.repoPath('suite_build')}`);
    return (await res.json()) as SuiteBuildUploadResult;
  }

  // GET /repos/:id/fix_packet?test_id= — the per-test Fix data packet. Relayed
  // down for the host to repair local code; 422 (non-failed / stale / no suite)
  // surfaces as a WireError carrying the server's business reason.
  async getFixPacket(testId: string): Promise<FixPacket> {
    const url = this.repoQueryPath('fix_packet', testId);
    const res = await this.send('GET', url);
    await this.ensureOk(res, `GET ${url}`);
    return (await res.json()) as FixPacket;
  }

  // GET /repos/:id/reshape_packet?test_id= — the reshape task. A 409 (the code is
  // gone) surfaces as a WireError carrying the server's "retire instead" message.
  async getReshapePacket(testId: string): Promise<ReshapePacket> {
    const url = this.repoQueryPath('reshape_packet', testId);
    const res = await this.send('GET', url);
    if (res.status === 409) throw new WireError(await this.errorMessage(res, url));
    await this.ensureOk(res, `GET ${url}`);
    return (await res.json()) as ReshapePacket;
  }

  // POST /repos/:id/reshape_candidate — upload the host's one new body; get back
  // the Rails-assembled candidate spec (not committed) to run as the local gate.
  async postReshapeCandidate(payload: unknown): Promise<ReshapeCandidateResult> {
    const res = await this.send('POST', this.repoPath('reshape_candidate'), payload);
    await this.ensureOk(res, `POST ${this.repoPath('reshape_candidate')}`);
    return (await res.json()) as ReshapeCandidateResult;
  }

  // POST /repos/:id/reshape — commit a reshape that passed the local gate. Sends
  // the same body it ran plus gate: "green"; Rails re-assembles and versions it.
  async postReshapeCommit(payload: unknown): Promise<ReshapeCommitResult> {
    const res = await this.send('POST', this.repoPath('reshape'), payload);
    await this.ensureOk(res, `POST ${this.repoPath('reshape')}`);
    return (await res.json()) as ReshapeCommitResult;
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

  private repoQueryPath(suffix: string, testId: string): string {
    return `${this.repoPath(suffix)}?test_id=${encodeURIComponent(testId)}`;
  }

  // The server's business-language error from a JSON `{ error }` body, falling
  // back to the raw status when the body is not the shape we expect.
  private async errorMessage(res: Response, url: string): Promise<string> {
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string' && body.error.trim()) return body.error;
    } catch {
      // fall through to the generic status message
    }
    return `GET ${url} failed: ${res.status} ${res.statusText}`;
  }

  private decodeSuiteBlob(payload: unknown): SuiteBlob {
    if (!payload || typeof payload !== 'object') {
      throw new WireError(`GET ${this.repoPath('suite')} returned a malformed suite payload.`);
    }

    const suite = payload as Record<string, unknown>;
    if (
      typeof suite.suite_digest !== 'string' ||
      typeof suite.spec_rb !== 'string' ||
      !Object.hasOwn(suite, 'manifest')
    ) {
      throw new WireError(
        `GET ${this.repoPath('suite')} returned a malformed suite payload: ` +
          'expected suite_digest, spec_rb, and manifest.',
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
