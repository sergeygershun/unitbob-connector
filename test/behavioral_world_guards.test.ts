import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { behavioralWorldFor } from '../src/files/behavioral.ts';
import { runProcess } from '../src/proc.ts';

// Spec 35-1, criterion 2. The JS and Python harnesses are not probed by a live
// runner the way the Ruby World is — that probe needs a Rails application to
// integrate with, and these two files integrate with nothing. So their one claim
// is executed here instead, in the language it is written in.
//
// It has to be executed rather than read, because the failure it guards against
// is invisible from inside: a suite whose guard never installed passes in exactly
// the same way, and only the far end of the wire ever finds out.

function worldIn(runner: string): string {
  const world = behavioralWorldFor(runner)!;
  const root = mkdtempSync(join(tmpdir(), 'unitbob-world-guard-'));
  const path = join(root, world.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, world.content);
  return path;
}

// A real listener on loopback, so "localhost still reachable" is answered by a
// connection that actually completes rather than by the absence of an error.
async function withLocalListener<T>(use: (port: number) => Promise<T>): Promise<T> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await use((server.address() as { port: number }).port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('the cucumber-js harness refuses a connection that leaves the machine', async () => {
  const world = worldIn('cucumber-js');
  const script = `
    require(${JSON.stringify(world)});
    const net = require('node:net');
    try {
      net.connect({ host: '192.0.2.1', port: 80 });
      console.log('NOT-BLOCKED');
    } catch (error) {
      console.log(error.message.includes('[unitbob]') ? 'BLOCKED' : 'WRONG-ERROR: ' + error.message);
    }
  `;

  const result = await runProcess(process.execPath, ['-e', script], { timeoutMs: 20_000 });
  assert.equal(result.stdout.trim(), 'BLOCKED', result.stderr);
});

// Node's own `fetch` opens its connections below `http.request`, so a guard one
// level up would have left the most modern way to call out as the one way that
// still worked.
test('the cucumber-js harness also covers global fetch, not only http.request', async () => {
  const world = worldIn('cucumber-js');
  const script = `
    require(${JSON.stringify(world)});
    fetch('http://192.0.2.1/')
      .then(() => console.log('NOT-BLOCKED'))
      .catch((error) => console.log(String(error.cause?.message ?? error.message).includes('[unitbob]') ? 'BLOCKED' : 'WRONG-ERROR: ' + error.message));
  `;

  const result = await runProcess(process.execPath, ['-e', script], { timeoutMs: 20_000 });
  assert.equal(result.stdout.trim(), 'BLOCKED', result.stderr);
});

test('the cucumber-js harness leaves localhost reachable', async () => {
  const world = worldIn('cucumber-js');
  const output = await withLocalListener(async (port) => {
    const script = `
      require(${JSON.stringify(world)});
      const net = require('node:net');
      const socket = net.connect({ host: '127.0.0.1', port: ${port} });
      socket.on('connect', () => { console.log('REACHED'); socket.end(); });
      socket.on('error', (error) => console.log('BLOCKED: ' + error.message));
    `;
    return await runProcess(process.execPath, ['-e', script], { timeoutMs: 20_000 });
  });

  assert.equal(output.stdout.trim(), 'REACHED', output.stderr);
});

test('the pytest-bdd harness refuses a connection that leaves the machine and keeps localhost', async (t) => {
  const python = await firstWorkingPython();
  if (!python) {
    t.skip('no python3 on this machine');
    return;
  }

  const world = worldIn('pytest-bdd');
  const output = await withLocalListener(async (port) => {
    const script = [
      'import runpy, socket',
      `runpy.run_path(${JSON.stringify(world)})`,
      'try:',
      "    socket.create_connection(('192.0.2.1', 80), timeout=5)",
      "    print('NOT-BLOCKED')",
      'except OSError as error:',
      "    print('BLOCKED' if '[unitbob]' in str(error) else 'WRONG-ERROR: %s' % error)",
      'try:',
      `    socket.create_connection(('127.0.0.1', ${port}), timeout=5).close()`,
      "    print('REACHED')",
      'except OSError as error:',
      "    print('LOCAL-BLOCKED: %s' % error)",
    ].join('\n');
    return await runProcess(python, ['-c', script], { timeoutMs: 30_000 });
  });

  assert.deepEqual(output.stdout.trim().split('\n'), ['BLOCKED', 'REACHED'], output.stderr);
});

async function firstWorkingPython(): Promise<string | null> {
  for (const candidate of ['python3', 'python']) {
    if ((await runProcess(candidate, ['--version'], { timeoutMs: 10_000 })).code === 0) return candidate;
  }
  return null;
}
