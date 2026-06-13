import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Wire, WireError } from '../src/wire.ts';
import type { Config } from '../src/config.ts';

interface Hit {
  method: string;
  url: string;
  body: string;
}

// Start a tiny HTTP server that records every request and answers via `handler`.
async function withServer(
  handler: (hit: Hit, res: import('node:http').ServerResponse) => void,
  fn: (config: Config, hits: Hit[]) => Promise<void>,
): Promise<void> {
  const hits: Hit[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const hit = { method: req.method ?? '', url: req.url ?? '', body };
      hits.push(hit);
      handler(hit, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const config: Config = { server: `http://127.0.0.1:${port}`, repoId: 3, projectRoot: '/project' };
  try {
    await fn(config, hits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

test('putGraph hits PUT /repos/:id/graph and returns the digest', async () => {
  await withServer(
    (_hit, res) => json(res, 200, { graph_digest: 'abc' }),
    async (config, hits) => {
      const rawGraphJson = '{\n  "nodes": []\n}\n';
      const result = await new Wire(config).putGraph(rawGraphJson);
      assert.deepEqual(result, { graph_digest: 'abc' });
      assert.equal(hits[0].method, 'PUT');
      assert.equal(hits[0].url, '/repos/3/graph');
      assert.equal(hits[0].body, rawGraphJson);
    },
  );
});

test('putMapBuild hits PUT /repos/:id/map_build and returns the version payload', async () => {
  await withServer(
    (_hit, res) =>
      json(res, 200, {
        map_version_id: 9,
        map_digest: 'map',
        graph_digest: 'graph',
        map_url: 'http://host/repos/3/map',
        reused: false,
      }),
    async (config, hits) => {
      const result = await new Wire(config).putMapBuild({ graph: { nodes: [] }, map_document: { version: 3 } });
      assert.equal(result.map_url, 'http://host/repos/3/map');
      assert.equal(hits[0].method, 'PUT');
      assert.equal(hits[0].url, '/repos/3/map_build');
      assert.deepEqual(JSON.parse(hits[0].body), { graph: { nodes: [] }, map_document: { version: 3 } });
    },
  );
});

test('putMapBuild surfaces validation errors as WireError', async () => {
  await withServer(
    (_hit, res) => json(res, 422, { error: 'blocks must not be empty' }),
    async (config) => {
      await assert.rejects(
        () => new Wire(config).putMapBuild({ graph: {}, map_document: {} }),
        (err: unknown) => err instanceof WireError && /422/.test((err as Error).message),
      );
    },
  );
});

test('getRecipe hits GET /recipes/:name', async () => {
  await withServer(
    (_hit, res) => json(res, 200, { name: 'decompose', version: 'v1', text: '# recipe' }),
    async (config, hits) => {
      const recipe = await new Wire(config).getRecipe('decompose');
      assert.equal(recipe.text, '# recipe');
      assert.equal(hits[0].method, 'GET');
      assert.equal(hits[0].url, '/recipes/decompose');
    },
  );
});

test('getRecipe maps 404 to a WireError', async () => {
  await withServer(
    (_hit, res) => res.writeHead(404).end(),
    async (config) => {
      await assert.rejects(() => new Wire(config).getRecipe('nope'), WireError);
    },
  );
});

test('getSuite returns the blob, and null on 204', async () => {
  await withServer(
    (_hit, res) => {
      json(res, 200, { suite_digest: 'd1', spec_rb: 'RSpec.describe("x") {}', manifest: { guardrails_id: 'g1' } });
    },
    async (config) => {
      const suite = await new Wire(config).getSuite();
      assert.deepEqual(suite, {
        suite_digest: 'd1',
        spec_rb: 'RSpec.describe("x") {}',
        manifest: { guardrails_id: 'g1' },
      });
    },
  );

  await withServer(
    (_hit, res) => res.writeHead(204).end(),
    async (config) => {
      assert.equal(await new Wire(config).getSuite(), null);
    },
  );
});

test('getSuite rejects malformed suite payloads before materialization', async () => {
  await withServer(
    (hit, res) => {
      if (hit.url === '/repos/3/suite') json(res, 200, { suite_digest: 'd1' });
      else res.writeHead(404).end();
    },
    async (config) => {
      await assert.rejects(
        () => new Wire(config).getSuite(),
        (err: unknown) => err instanceof WireError && /malformed suite payload/.test((err as Error).message),
      );
    },
  );
});

test('postRun hits POST /repos/:id/runs and returns the summary', async () => {
  await withServer(
    (_hit, res) => json(res, 200, { blocks: [] }),
    async (config, hits) => {
      const summary = await new Wire(config).postRun({ suite_digest: 'd1', rspec_json: {} });
      assert.deepEqual(summary, { blocks: [] });
      assert.equal(hits[0].method, 'POST');
      assert.equal(hits[0].url, '/repos/3/runs');
    },
  );
});

test('getLamps hits GET /repos/:id/lamps', async () => {
  await withServer(
    (_hit, res) => json(res, 200, { blocks: [] }),
    async (config, hits) => {
      await new Wire(config).getLamps();
      assert.equal(hits[0].url, '/repos/3/lamps');
    },
  );
});

test('an unreachable server throws an actionable WireError, never a fabricated result', async () => {
  // Port 1 is reserved and nothing listens there → connection refused.
  const config: Config = { server: 'http://127.0.0.1:1', repoId: 3, projectRoot: '/project' };
  await assert.rejects(
    () => new Wire(config).getLamps(),
    (err: unknown) => err instanceof WireError && /Cannot reach the Unitbob server/.test((err as Error).message),
  );
});
