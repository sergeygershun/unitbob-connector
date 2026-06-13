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

test('getSuitePackets hits GET /repos/:id/suite_packets and relays the payload', async () => {
  await withServer(
    (_hit, res) => json(res, 200, { map_digest: 'sha256-map', packets: [{ block: { id: 'block:billing' } }] }),
    async (config, hits) => {
      const result = await new Wire(config).getSuitePackets();
      assert.equal(result.map_digest, 'sha256-map');
      assert.equal(hits[0].method, 'GET');
      assert.equal(hits[0].url, '/repos/3/suite_packets');
    },
  );
});

test('getSuitePackets surfaces a 409 (no current map) as a WireError', async () => {
  await withServer(
    (_hit, res) => json(res, 409, { error: 'No current map — run `/unitbob map` first.' }),
    async (config) => {
      await assert.rejects(
        () => new Wire(config).getSuitePackets(),
        (err: unknown) => err instanceof WireError && /unitbob map/.test((err as Error).message),
      );
    },
  );
});

test('putSuiteBuild hits PUT /repos/:id/suite_build and returns the new suite identity', async () => {
  await withServer(
    (_hit, res) =>
      json(res, 200, {
        suite_version_id: 9,
        suite_digest: 'sha256-suite',
        map_url: 'http://host/repos/3',
        counts: { covered: 2 },
      }),
    async (config, hits) => {
      const result = await new Wire(config).putSuiteBuild({ map_digest: 'sha256-map', blocks: [] });
      assert.equal(result.suite_version_id, 9);
      assert.equal(hits[0].method, 'PUT');
      assert.equal(hits[0].url, '/repos/3/suite_build');
      assert.deepEqual(JSON.parse(hits[0].body), { map_digest: 'sha256-map', blocks: [] });
    },
  );
});

test('putSuiteBuild surfaces validation errors as WireError', async () => {
  await withServer(
    (_hit, res) => json(res, 422, { error: 'map_digest does not match the current map' }),
    async (config) => {
      await assert.rejects(
        () => new Wire(config).putSuiteBuild({ map_digest: 'stale', blocks: [] }),
        (err: unknown) => err instanceof WireError && /422/.test((err as Error).message),
      );
    },
  );
});

test('getFixPacket hits GET /repos/:id/fix_packet?test_id= and relays the packet', async () => {
  await withServer(
    (_hit, res) =>
      json(res, 200, {
        headline: 'Billing can still take a payment',
        test_body: 'expect(true).to be true',
        failure_message: 'boom',
        anchor: 'BillingService#charge',
        message: 'Ready to fix «Billing can still take a payment».',
      }),
    async (config, hits) => {
      const packet = await new Wire(config).getFixPacket('guard-1');
      assert.equal(packet.anchor, 'BillingService#charge');
      assert.equal(hits[0].method, 'GET');
      assert.equal(hits[0].url, '/repos/3/fix_packet?test_id=guard-1');
    },
  );
});

test('getFixPacket surfaces a 422 (non-failed) as a WireError', async () => {
  await withServer(
    (_hit, res) => json(res, 422, { error: 'That check is not failing.' }),
    async (config) => {
      await assert.rejects(
        () => new Wire(config).getFixPacket('guard-1'),
        (err: unknown) => err instanceof WireError && /not failing/.test((err as Error).message),
      );
    },
  );
});

test('getReshapePacket relays recipe + packet + suite_digest, and maps 409 to a clean WireError', async () => {
  await withServer(
    (_hit, res) =>
      json(res, 200, {
        recipe: { name: 'generate', version: 'g1', text: 'g' },
        packet: { block: { id: 'block:billing' } },
        suite_digest: 'sha256-suite',
      }),
    async (config, hits) => {
      const packet = await new Wire(config).getReshapePacket('guard-1');
      assert.equal(packet.suite_digest, 'sha256-suite');
      assert.equal(hits[0].url, '/repos/3/reshape_packet?test_id=guard-1');
    },
  );

  await withServer(
    (_hit, res) => json(res, 409, { error: 'The code is gone — retire instead.' }),
    async (config) => {
      await assert.rejects(
        () => new Wire(config).getReshapePacket('guard-1'),
        (err: unknown) => err instanceof WireError && /retire instead/.test((err as Error).message),
      );
    },
  );
});

test('postReshapeCandidate and postReshapeCommit hit the right endpoints', async () => {
  await withServer(
    (hit, res) => {
      if (hit.url === '/repos/3/reshape_candidate') json(res, 200, { candidate_spec: 'spec', red_message: 'nope' });
      else json(res, 200, { suite_version_id: 1, suite_digest: 'd', map_url: 'u', message: 'ok' });
    },
    async (config, hits) => {
      const c = await new Wire(config).postReshapeCandidate({ test_id: 'g' });
      assert.equal(c.candidate_spec, 'spec');
      const commit = await new Wire(config).postReshapeCommit({ test_id: 'g', gate: 'green' });
      assert.equal(commit.message, 'ok');
      assert.deepEqual(hits.map((h) => `${h.method} ${h.url}`), [
        'POST /repos/3/reshape_candidate',
        'POST /repos/3/reshape',
      ]);
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
