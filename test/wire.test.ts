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
  authorization: string | undefined;
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
      const hit = {
        method: req.method ?? '',
        url: req.url ?? '',
        body,
        authorization: req.headers.authorization,
      };
      hits.push(hit);
      handler(hit, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const config: Config = {
    server: `http://127.0.0.1:${port}`,
    repoId: 3,
    token: 'secret-token',
    projectRoot: '/project',
  };
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
    (_hit, res) => json(res, 200, { map_digest: 'sha256-map', blocks: [{ block_id: 'billing', interfaces: [] }] }),
    async (config, hits) => {
      const result = await new Wire(config).getSuitePackets();
      assert.equal(result.map_digest, 'sha256-map');
      assert.equal(result.blocks.length, 1);
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
      const result = await new Wire(config).putSuiteBuild({
        map_digest: 'sha256-map',
        spec_rb: "require 'rails_helper'\n",
        test_metadata: { capabilities: [] },
      });
      assert.equal(result.suite_version_id, 9);
      assert.equal(hits[0].method, 'PUT');
      assert.equal(hits[0].url, '/repos/3/suite_build');
      assert.deepEqual(JSON.parse(hits[0].body), {
        map_digest: 'sha256-map',
        spec_rb: "require 'rails_helper'\n",
        test_metadata: { capabilities: [] },
      });
    },
  );
});

test('putSuiteBuild surfaces validation errors as WireError', async () => {
  await withServer(
    (_hit, res) => json(res, 422, { error: 'map_digest does not match the current map' }),
    async (config) => {
      await assert.rejects(
        () => new Wire(config).putSuiteBuild({ map_digest: 'stale', spec_rb: 'x', test_metadata: {} }),
        (err: unknown) => err instanceof WireError && /422/.test((err as Error).message),
      );
    },
  );
});

test('getFixPacket hits GET /repos/:id/fix_packet?interface_id= and relays the packet', async () => {
  await withServer(
    (_hit, res) =>
      json(res, 200, {
        interface_id: 'billing_charge',
        headline: 'Billing can still take a payment',
        failure_message: 'boom',
        anchor: 'BillingService#charge',
        prompt: 'You are fixing a failed Unitbob check.',
        message: 'Ready to work on «Billing can still take a payment».',
      }),
    async (config, hits) => {
      const packet = await new Wire(config).getFixPacket('billing_charge');
      assert.equal(packet.anchor, 'BillingService#charge');
      assert.equal(packet.prompt, 'You are fixing a failed Unitbob check.');
      assert.equal(packet.interface_id, 'billing_charge');
      assert.equal(hits[0].method, 'GET');
      assert.equal(hits[0].url, '/repos/3/fix_packet?interface_id=billing_charge');
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
      json(res, 200, {
        suite_digest: 'd1',
        suite_file: { path: '.unitbob/guardrails/architecture_map_contracts_spec.rb', content: 'RSpec.describe("x") {}' },
        runner_manifest: { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' },
      });
    },
    async (config) => {
      const suite = await new Wire(config).getSuite();
      assert.deepEqual(suite, {
        suite_digest: 'd1',
        suite_file: { path: '.unitbob/guardrails/architecture_map_contracts_spec.rb', content: 'RSpec.describe("x") {}' },
        runner_manifest: { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' },
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

test('getSuitePacketsBatch returns the two peer packets', async () => {
  await withServer(
    (_hit, res) => json(res, 200, { suite_packets: [{ suite_kind: 'structural' }, { suite_kind: 'behavioral' }] }),
    async (config, hits) => {
      const packets = await new Wire(config).getSuitePacketsBatch();
      assert.deepEqual(packets.map((p) => p.suite_kind), ['structural', 'behavioral']);
      assert.equal(hits[0].url, '/repos/3/suite_packets');
    },
  );
});

test('putSuiteBuilds PUTs the batch and returns one result per kind', async () => {
  await withServer(
    (_hit, res) => json(res, 200, { results: [{ suite_kind: 'structural', status: 'created' }], map_url: 'u' }),
    async (config, hits) => {
      const results = await new Wire(config).putSuiteBuilds([
        { suite_kind: 'structural', source_digest: 'm', artifacts: { suite_file: {}, runner_manifest: {}, test_metadata: {} } },
      ]);
      assert.equal(results[0].status, 'created');
      assert.equal(hits[0].method, 'PUT');
      assert.equal(hits[0].url, '/repos/3/suite_builds');
      assert.equal(JSON.parse(hits[0].body).suite_builds.length, 1);
    },
  );
});

test('getSuites returns the two peer suite items', async () => {
  await withServer(
    (_hit, res) => json(res, 200, { suites: [{ suite_kind: 'structural', status: 'ready' }, { suite_kind: 'behavioral', status: 'not_built' }] }),
    async (config, hits) => {
      const suites = await new Wire(config).getSuites();
      assert.deepEqual(suites.map((s) => s.status), ['ready', 'not_built']);
      assert.equal(hits[0].url, '/repos/3/suites');
    },
  );
});

test('postRunsBatch POSTs the runs and returns results + one map_url', async () => {
  await withServer(
    (_hit, res) => json(res, 200, { results: [{ suite_kind: 'behavioral', status: 'ok', summary: 'ok' }], map_url: 'http://host/repos/3/map' }),
    async (config, hits) => {
      const { results, map_url } = await new Wire(config).postRunsBatch([{ suite_digest: 'd', run_result: '{}' }]);
      assert.equal(results[0].suite_kind, 'behavioral');
      assert.equal(map_url, 'http://host/repos/3/map');
      assert.equal(hits[0].method, 'POST');
      assert.equal(hits[0].url, '/repos/3/runs/batch');
    },
  );
});

test('getContractPrompt hits GET /contract_prompt with the digest+test_id+intent query', async () => {
  await withServer(
    (_hit, res) => json(res, 200, { suite_digest: 'd', suite_kind: 'behavioral', test_id: 'checkout', intent: 'fix', prompt: 'p', message: 'm' }),
    async (config, hits) => {
      const packet = await new Wire(config).getContractPrompt('d', 'checkout', 'fix');
      assert.equal(packet.prompt, 'p');
      assert.match(hits[0].url, /^\/repos\/3\/contract_prompt\?/);
      assert.match(hits[0].url, /suite_digest=d/);
      assert.match(hits[0].url, /test_id=checkout/);
      assert.match(hits[0].url, /intent=fix/);
    },
  );
});

test('a batch endpoint answering without its array is a WireError', async () => {
  await withServer(
    (_hit, res) => json(res, 200, { nope: true }),
    async (config) => {
      await assert.rejects(() => new Wire(config).getSuites(), (err) => err instanceof WireError);
    },
  );
});

test('an unreachable server throws an actionable WireError, never a fabricated result', async () => {
  // Port 1 is reserved and nothing listens there → connection refused.
  const config: Config = {
    server: 'http://127.0.0.1:1',
    repoId: 3,
    token: 'secret-token',
    projectRoot: '/project',
  };
  await assert.rejects(
    () => new Wire(config).getLamps(),
    (err: unknown) => err instanceof WireError && /Cannot reach the Unitbob server/.test((err as Error).message),
  );
});

// Spec 33. The project's token rides on every wire call; without it the brain
// answers 404, and it answers the same 404 for a token that belongs to someone
// else — a 403 would confirm the project exists.
test('every wire call carries the project token', async () => {
  await withServer(
    (_hit, res) => json(res, 200, { suites: [] }),
    async (config, hits) => {
      await new Wire(config).getSuites();
      assert.equal(hits[0].authorization, 'Bearer secret-token');
    },
  );
});

test('a 404 on the wire is explained, not shown as a bare status', async () => {
  await withServer(
    (_hit, res) => json(res, 404, {}),
    async (config) => {
      await assert.rejects(
        new Wire(config).getSuites(),
        (err: Error) =>
          err instanceof WireError &&
          /does not have/.test(err.message) &&
          /Delete \.unitbob\.json/.test(err.message),
      );
    },
  );
});

// The recipe endpoint keeps its own 404 message: there the missing thing is the
// recipe, not the project.
test('an unknown recipe still says so by name', async () => {
  await withServer(
    (_hit, res) => json(res, 404, {}),
    async (config) => {
      await assert.rejects(
        new Wire(config).getRecipe('nope'),
        (err: Error) => err instanceof WireError && /Unknown recipe "nope"/.test(err.message),
      );
    },
  );
});
