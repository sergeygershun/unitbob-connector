import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyHint } from '../src/proxyHint.ts';

// a2time, 2026-08-17. The host was added to the sandbox allowlist, `curl` began
// answering 200, and `npx unitbob` kept answering 403 — because Node does not
// route its own `fetch` through `HTTPS_PROXY` unless it is told to. The run
// found the cure by guessing. These tests are what says it out loud instead.
//
// A remote brain, a current Node, and nothing exempting either: the case where
// the sentence is true. Every other test here is about not saying it.
const REMOTE = 'https://unitbob.example.com';
const CURRENT_NODE = 'v25.2.1';
const hint = (env: NodeJS.ProcessEnv, target = REMOTE, nodeVersion = CURRENT_NODE): string | null =>
  proxyHint(target, { env, nodeVersion });

test('no proxy in the environment, nothing to say', () => {
  assert.equal(hint({}), null);
  assert.equal(hint({ HTTPS_PROXY: '' }), null);
  assert.equal(hint({ HTTPS_PROXY: '   ' }), null);
});

test('a proxy in the environment names it, and names the cure', () => {
  const said = hint({ HTTPS_PROXY: 'http://proxy.internal:3128' });
  assert.ok(said, 'expected a hint');
  assert.match(said, /HTTPS_PROXY=http:\/\/proxy\.internal:3128/);
  assert.match(said, /NODE_USE_ENV_PROXY=1/);
});

test('the lowercase spellings count too, and the https one wins', () => {
  assert.match(hint({ http_proxy: 'http://a:3128' }) ?? '', /http_proxy=http:\/\/a:3128/);
  assert.match(
    hint({ HTTP_PROXY: 'http://plain:3128', HTTPS_PROXY: 'http://secure:3128' }) ?? '',
    /HTTPS_PROXY=http:\/\/secure:3128/,
  );
});

// A proxy URL is one of the few places a password is still written in plain
// text, and this sentence is printed into terminals, transcripts and bug
// reports. The host is the part that helps; the credentials never are.
test('credentials in the proxy URL are never printed', () => {
  const said = hint({ HTTPS_PROXY: 'http://bob:hunter2@proxy.internal:3128' }) ?? '';
  assert.doesNotMatch(said, /hunter2/);
  assert.doesNotMatch(said, /bob/);
  assert.match(said, /proxy\.internal:3128/);
});

// An unparseable value still means "this machine has a proxy" — worth saying —
// but nothing in it is safe to echo, since we cannot find the credentials in it.
test('a proxy value that is not a URL is reported without its value', () => {
  const said = hint({ HTTPS_PROXY: 'not a url at all' }) ?? '';
  assert.match(said, /HTTPS_PROXY/);
  assert.doesNotMatch(said, /not a url at all/);
  assert.match(said, /NODE_USE_ENV_PROXY=1/);
});

// Telling somebody to set a variable they already set is worse than silence: it
// sends them to fix the one thing that is not broken.
test('nothing to say once Node is already using the proxy', () => {
  const env = { HTTPS_PROXY: 'http://proxy.internal:3128' };
  assert.equal(hint({ ...env, NODE_USE_ENV_PROXY: '1' }), null);
  assert.equal(hint({ ...env, NODE_OPTIONS: '--use-env-proxy' }), null);
  // The spellings that mean "off" leave the machine needing the sentence.
  assert.ok(hint({ ...env, NODE_USE_ENV_PROXY: '0' }));
  assert.ok(hint({ ...env, NODE_USE_ENV_PROXY: 'false' }));
});

// Measured on Node 25.2.1 against a CONNECT-logging proxy: with the variable
// set, Node tunnels `http://127.0.0.1:19999` through the proxy as readily as any
// public host. So for a vibecoder running the brain locally, this advice would
// take a working setup and break it — the proxy has no route back to their own
// machine.
test('a brain on this machine is never blamed on the proxy', () => {
  const env = { HTTPS_PROXY: 'http://proxy.internal:3128' };
  assert.equal(hint(env, 'http://localhost:3000'), null);
  assert.equal(hint(env, 'http://127.0.0.1:3000'), null);
  assert.equal(hint(env, 'http://[::1]:3000'), null);
});

// The other exemption Node applies. Advice that contradicts what setting the
// variable would actually do is worse than no advice.
test('a target the environment already exempts gets no advice', () => {
  const env = { HTTPS_PROXY: 'http://proxy.internal:3128' };
  assert.equal(hint({ ...env, NO_PROXY: 'unitbob.example.com' }), null);
  assert.equal(hint({ ...env, NO_PROXY: '.example.com' }), null);
  assert.equal(hint({ ...env, no_proxy: 'other.test, example.com' }), null);
  assert.equal(hint({ ...env, NO_PROXY: '*' }), null);
  // A neighbouring name is not a suffix match.
  assert.ok(hint({ ...env, NO_PROXY: 'notexample.com' }));
});

// `NODE_USE_ENV_PROXY` is not in every Node this package supports (`engines`
// says >=18). Naming it to a Node that ignores it is a second round of the same
// confusion, so an old one is told the true cause and the only real cure.
test('an old Node is told the cause, not a variable it would ignore', () => {
  const env = { HTTPS_PROXY: 'http://proxy.internal:3128' };
  const said = hint(env, REMOTE, 'v18.20.4') ?? '';
  assert.match(said, /reaches the network through a proxy/);
  assert.doesNotMatch(said, /NODE_USE_ENV_PROXY/);
  assert.match(said, /Node 22 or newer/);
  assert.match(hint(env, REMOTE, 'v22.22.3') ?? '', /NODE_USE_ENV_PROXY=1/);
});
