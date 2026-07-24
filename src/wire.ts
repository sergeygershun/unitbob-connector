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
  surface_digest: string;
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

// One peer packet from the batch GET /suite_packets (spec 32): the assignment
// for one contract system. The connector reads only `suite_kind`, `source_digest`,
// and `path_root`; the `assignment` body is opaque and relayed to the host.
export interface SuitePacket {
  suite_kind: string;
  source_digest: string;
  path_root: string;
  assignment: unknown;
}

// One peer build outcome uploaded in the batch PUT /suite_builds. Exactly one of
// `artifacts` or `build_error` is set. `artifacts` is the host's verbatim
// answer; `build_error` records that the host could not build this branch at all.
export interface SuiteBuildItem {
  suite_kind: string;
  source_digest: string;
  artifacts?: {
    suite_file: unknown;
    runner_manifest: unknown;
    test_metadata: unknown;
  };
  build_error?: { message: string };
}

// The per-kind result the server returns for each uploaded branch. Printed
// verbatim; the connector reads only `suite_kind` and `status` for its summary.
export interface SuiteBuildResult {
  suite_kind: string;
  status: string;
  suite_version_id?: number;
  suite_digest?: string;
  error?: string;
  counts?: Record<string, number>;
}

export interface SuiteBuildUploadResult {
  suite_version_id: number;
  suite_digest: string;
  map_url: string;
  // The server-computed tallies, printed verbatim. Kept as a loose map so the
  // connector names none of the server's domain buckets.
  counts: Record<string, number>;
}

// One peer suite from the batch GET /suites (spec 32). A `ready` item carries
// the full suite blob to materialize and run; a `not_built` item has nothing to
// run and is skipped.
export interface SuiteListItem {
  suite_kind: string;
  status: string;
  suite_digest?: string;
  suite_file?: SuiteArtifact;
  runner_manifest?: RunnerManifestWire;
}

export interface SuiteArtifact {
  path: string;
  content: string;
  support_files?: { path: string; content: string }[];
}

export interface RunnerManifestWire {
  runner: string;
  [key: string]: unknown;
}

// One per-kind run summary the server returns from POST /runs/batch. Printed
// verbatim; the connector reads only `suite_kind`, `summary`, and `status`.
export interface RunResultItem {
  suite_kind: string | null;
  suite_digest: string;
  status: string;
  summary: string;
  lamps?: unknown;
}

// The contract action brief (spec 32) — one operation for both maps and both
// intents. Carries no source and no test body; the connector prints `message`
// and copies `prompt`.
export interface ContractPrompt {
  suite_digest: string;
  suite_kind: string;
  test_id: string;
  intent: string;
  headline: string;
  failure_message: string;
  prompt: string;
  message: string;
  [key: string]: unknown;
}

// The per-capability repair data packet (spec 26). Carries no source and no test
// body — the host reads its own checkout and the whole local spec file. The
// connector relays the packet down and prints `message`.
export interface FixPacket {
  interface_id: string;
  headline: string;
  failure_message: string;
  anchor: string | null;
  prompt: string;
  message: string;
}

// Raised when the server cannot be reached or answers with an error status.
// Verbs surface its message and exit non-zero; they never fabricate a result.
export class WireError extends Error {}

// POST /repos/register — the linking bootstrap (spec 28). A standalone function
// rather than a Wire method because at link time there is no Config yet: only a
// server URL and the project's folder name. Idempotent on the server.
export async function registerRepo(server: string, name: string): Promise<number> {
  const url = `${server}/repos/register`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  } catch (err) {
    throw new WireError(
      `Cannot reach the Unitbob server at ${server} (${(err as Error).message}). ` +
        'Check that the server is running.',
    );
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      // ignore — the status alone is actionable enough
    }
    throw new WireError(`POST ${url} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }

  const payload = (await res.json()) as { id?: unknown };
  if (typeof payload.id !== 'number' || !Number.isInteger(payload.id)) {
    throw new WireError(`POST ${url} returned a malformed payload: expected an integer id.`);
  }
  return payload.id;
}

export class Wire {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  // PUT /repos/:id/map_build — upload the fresh graph and both host-built lenses
  // (decompose map_document + surfaces inventory + grouped surface_document) as
  // one atomic bundle. Rails validates both documents, versions, and computes all
  // digests; either lens failing rejects the whole bundle (spec 31).
  async putMapBuild(payload: {
    graph: unknown;
    map_document: unknown;
    surfaces: unknown;
    surface_document: unknown;
  }): Promise<MapBuildUploadResult> {
    const res = await this.send('PUT', this.repoPath('map_build'), payload);
    await this.ensureOk(res, `PUT ${this.repoPath('map_build')}`);
    return (await res.json()) as MapBuildUploadResult;
  }

  // GET /repos/:id/suite_packets — the two peer assignments (spec 32), exactly
  // one per contract system. Relayed opaque; 409 (no current map) surfaces as a
  // WireError carrying the server's "run the Unitbob map first" guidance.
  async getSuitePacketsBatch(): Promise<SuitePacket[]> {
    const res = await this.send('GET', this.repoPath('suite_packets'));
    await this.ensureOk(res, `GET ${this.repoPath('suite_packets')}`);
    const body = (await res.json()) as { suite_packets?: unknown };
    if (!Array.isArray(body.suite_packets)) {
      throw new WireError(`GET ${this.repoPath('suite_packets')} returned no suite_packets array.`);
    }
    return body.suite_packets as SuitePacket[];
  }

  // PUT /repos/:id/suite_builds — upload both peer branches in one batch (spec
  // 32). Each item is validated and published independently; the response
  // carries one result per suite_kind.
  async putSuiteBuilds(items: SuiteBuildItem[]): Promise<SuiteBuildResult[]> {
    const res = await this.send('PUT', this.repoPath('suite_builds'), { suite_builds: items });
    await this.ensureOk(res, `PUT ${this.repoPath('suite_builds')}`);
    const body = (await res.json()) as { results?: unknown };
    if (!Array.isArray(body.results)) {
      throw new WireError(`PUT ${this.repoPath('suite_builds')} returned no results array.`);
    }
    return body.results as SuiteBuildResult[];
  }

  // GET /repos/:id/suites — both current suites (spec 32), exactly two peer
  // items. A `ready` item carries its blob; a `not_built` item is skipped.
  async getSuites(): Promise<SuiteListItem[]> {
    const res = await this.send('GET', this.repoPath('suites'));
    await this.ensureOk(res, `GET ${this.repoPath('suites')}`);
    const body = (await res.json()) as { suites?: unknown };
    if (!Array.isArray(body.suites)) {
      throw new WireError(`GET ${this.repoPath('suites')} returned no suites array.`);
    }
    return body.suites as SuiteListItem[];
  }

  // POST /repos/:id/runs/batch — ship each branch's raw report (or suite error)
  // in one batch; the server parses each against the exact stored version and
  // returns one summary per branch plus one shared map URL.
  async postRunsBatch(runs: unknown[]): Promise<{ results: RunResultItem[]; map_url: string }> {
    const res = await this.send('POST', this.repoPath('runs/batch'), { runs });
    await this.ensureOk(res, `POST ${this.repoPath('runs/batch')}`);
    const body = (await res.json()) as { results?: unknown; map_url?: unknown };
    if (!Array.isArray(body.results)) {
      throw new WireError(`POST ${this.repoPath('runs/batch')} returned no results array.`);
    }
    return { results: body.results as RunResultItem[], map_url: String(body.map_url ?? '') };
  }

  // GET /repos/:id/contract_prompt?suite_digest=&test_id=&intent= — the one
  // contract action operation for both maps and both intents (spec 32).
  async getContractPrompt(suiteDigest: string, testId: string, intent: string): Promise<ContractPrompt> {
    const query = new URLSearchParams({ suite_digest: suiteDigest, test_id: testId, intent });
    const url = `${this.repoPath('contract_prompt')}?${query}`;
    const res = await this.send('GET', url);
    await this.ensureOk(res, `GET ${url}`);
    return (await res.json()) as ContractPrompt;
  }

  // GET /repos/:id/suite_packets — the legacy singular assignment (spec 26),
  // kept for the structural-only flow. Relayed opaque.
  async getSuitePackets(): Promise<SuitePackets> {
    const res = await this.send('GET', this.repoPath('suite_packets'));
    await this.ensureOk(res, `GET ${this.repoPath('suite_packets')}`);
    return (await res.json()) as SuitePackets;
  }

  // PUT /repos/:id/suite_build — upload the host's complete, locally-validated
  // suite artifact: the verbatim suite_file, the suite-level runner_manifest,
  // and the capability-keyed test_metadata. The server validates the artifact,
  // stores it verbatim, versions, and returns the new suite's identity.
  async putSuiteBuild(payload: {
    map_digest: string;
    suite_file: unknown;
    runner_manifest: unknown;
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
    const file = suite.suite_file as Record<string, unknown> | undefined;
    const manifest = suite.runner_manifest as Record<string, unknown> | undefined;
    const wellFormed =
      typeof suite.suite_digest === 'string' &&
      file != null && typeof file === 'object' &&
      typeof file.path === 'string' && typeof file.content === 'string' &&
      manifest != null && typeof manifest === 'object' &&
      typeof manifest.runner === 'string';
    if (!wellFormed) {
      throw new WireError(
        `GET ${this.repoPath('suite')} returned a malformed suite payload: ` +
          'expected suite_digest, suite_file { path, content }, and runner_manifest.runner.',
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
