import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRepo, WireError } from '../src/wire.ts';
import { ensureLinked } from '../src/link.ts';

interface Hit {
  method: string;
  url: string;
  body: string;
}

// A tiny register endpoint: records hits, answers { id, name }.
async function withRegisterServer(
  id: number,
  fn: (server: string, hits: Hit[]) => Promise<void>,
): Promise<void> {
  const hits: Hit[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, name: JSON.parse(body).name }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, hits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// A project dir ensureLinked will accept: a real folder with a .git in it.
function tmpProject(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'unitbob-link-')), name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

test('registerRepo posts the name and returns the id', async () => {
  await withRegisterServer(7, async (server, hits) => {
    assert.equal(await registerRepo(server, 'a2time'), 7);
    assert.equal(hits[0].method, 'POST');
    assert.equal(hits[0].url, '/repos/register');
    assert.deepEqual(JSON.parse(hits[0].body), { name: 'a2time' });
  });
});

test('registerRepo maps an unreachable server to an actionable WireError', async () => {
  await assert.rejects(
    registerRepo('http://127.0.0.1:1', 'a2time'),
    (err: Error) => err instanceof WireError && /Cannot reach the Unitbob server/.test(err.message),
  );
});

test('ensureLinked registers a fresh project, writes the file, and announces once', async () => {
  await withRegisterServer(2, async (server) => {
    const dir = tmpProject('a2time');
    const out = await captureStdout(async () => {
      const config = await ensureLinked(dir, server);
      assert.deepEqual(config, { server, repoId: 2, projectRoot: dir });
    });

    assert.match(out, /Linked this project to Unitbob as a2time\./);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.unitbob.json'), 'utf8')), {
      server,
      repo_id: 2,
    });
    // The fresh link also git-ignores the connector's files.
    assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /\.unitbob\.json/);
  });
});

test('ensureLinked heals a legacy repo_id: 0 file', async () => {
  await withRegisterServer(5, async (server) => {
    const dir = tmpProject('legacy');
    writeFileSync(join(dir, '.unitbob.json'), JSON.stringify({ server, repo_id: 0 }));

    const out = await captureStdout(async () => {
      const config = await ensureLinked(dir, server);
      assert.equal(config.repoId, 5);
    });

    assert.match(out, /Linked this project to Unitbob as legacy\./);
    assert.equal(JSON.parse(readFileSync(join(dir, '.unitbob.json'), 'utf8')).repo_id, 5);
  });
});

test('ensureLinked is silent when the file matches the server', async () => {
  await withRegisterServer(2, async (server, hits) => {
    const dir = tmpProject('a2time');
    writeFileSync(join(dir, '.unitbob.json'), JSON.stringify({ server, repo_id: 2 }));

    const out = await captureStdout(async () => {
      const config = await ensureLinked(dir, server);
      assert.equal(config.repoId, 2);
    });

    // node:test writes its own runner protocol to stdout, so assert on our
    // line's absence rather than on emptiness.
    assert.doesNotMatch(out, /Linked this project/);
    assert.equal(hits.length, 1); // still resolved by name — that is the reconciliation
  });
});

test('ensureLinked fails early on a mismatched id and leaves the file alone', async () => {
  await withRegisterServer(2, async (server) => {
    const dir = tmpProject('a2time');
    writeFileSync(join(dir, '.unitbob.json'), JSON.stringify({ server, repo_id: 9 }));

    await assert.rejects(
      ensureLinked(dir, server),
      (err: Error) =>
        err instanceof WireError && /points at repo 9/.test(err.message) && /repo 2/.test(err.message),
    );
    assert.equal(JSON.parse(readFileSync(join(dir, '.unitbob.json'), 'utf8')).repo_id, 9);
  });
});

test('ensureLinked refuses to register outside a project root, before any request', async () => {
  await withRegisterServer(2, async (server, hits) => {
    const dir = mkdtempSync(join(tmpdir(), 'unitbob-not-a-project-')); // no .git
    await assert.rejects(
      ensureLinked(dir, server),
      (err: Error) => err instanceof WireError && /project's root folder/.test(err.message),
    );
    assert.equal(hits.length, 0);
    assert.equal(existsSync(join(dir, '.unitbob.json')), false);
  });
});
