// What to say when a wire call fails on a machine that reaches the network
// through a proxy.
//
// a2time, 2026-08-17. The Unitbob host was added to the sandbox's allowlist,
// `curl` started answering 200, and the connector went on failing with 403 for
// another round of debugging. Both facts were true at once: `curl` reads
// `HTTPS_PROXY` from the environment, and Node's `fetch` does not, so the two
// were not talking to the same place. Nothing in the failure said so — the
// connector printed the status it got and left the reader to guess that the
// variable sitting in their own environment was being ignored.
//
// This module is one sentence, and deliberately not a fix. Routing our requests
// through the proxy ourselves would mean either a runtime dependency (this
// package has none, on purpose — `npx unitbob` installs in a second) or
// re-spawning ourselves with the variable set, which works on some Node versions
// and silently does not on others. Naming the cause costs nothing and cannot
// break a working machine.
//
// What it *can* do is send somebody to break one, which is why so much of this
// file is about staying quiet. Measured on Node 25.2.1 against a CONNECT-logging
// proxy: with `NODE_USE_ENV_PROXY=1` set, Node tunnels `http://127.0.0.1:19999`
// through the proxy too — it does not exempt loopback. So this sentence, said to
// somebody whose brain runs on `http://localhost:3000` and is merely down, would
// talk them into breaking the one setup that works.

// The variables that mean "this machine has a proxy", in the order they answer
// for an `https://` server. The lowercase spellings are not a nicety: on Unix
// they are the older convention and plenty of environments still set only those.
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

// The first Node that can be told to use the environment's proxy for `fetch`.
// Below it the variable is inert, so naming it would be a second round of the
// exact confusion this file exists to end. Held at major-version granularity on
// purpose: 18 and 20 plainly have nothing, 22 has it (a2time ran 22.22.3 and the
// variable cured it), and pinning a patch number this file cannot verify would
// be a guess dressed as a fact.
const FIRST_NODE_WITH_ENV_PROXY = 22;

export interface ProxyHintOptions {
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
}

// The sentence to add to a message that has already failed, or null when there
// is nothing worth saying: no proxy configured, one Node is already using, or a
// target that would not go through it anyway.
//
// `target` is the server the failed call was aimed at. It is required rather
// than optional because every rule below that keeps this quiet needs it, and an
// optional argument here would be a hint that is silently louder at half its
// call sites.
export function proxyHint(target: string, options: ProxyHintOptions = {}): string | null {
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.version;

  if (nodeAlreadyUsesTheProxy(env)) return null;

  const found = PROXY_VARS.map((name) => ({ name, value: (env[name] ?? '').trim() })).find(
    (candidate) => candidate.value.length > 0,
  );
  if (!found) return null;
  if (!goesThroughTheProxy(target, env)) return null;

  const shown = withoutCredentials(found.value);
  const where = shown ? `\`${found.name}=${shown}\`` : `\`${found.name}\``;
  const cause =
    `This machine reaches the network through a proxy (${where}), and Node does not send its own ` +
    'requests through it unless it is told to — which is why `curl` can reach a host that this command cannot.';

  return majorVersion(nodeVersion) < FIRST_NODE_WITH_ENV_PROXY
    ? `${cause} This Node (${nodeVersion}) has no way to be told: run the command under Node ` +
        `${FIRST_NODE_WITH_ENV_PROXY} or newer.`
    : `${cause} Re-run the same command with \`NODE_USE_ENV_PROXY=1\` in front of it.`;
}

// Whether Node is already routing `fetch` through the environment's proxy, in
// either of the two ways it can be asked to. The words that mean "off" are
// spelled out rather than "anything but 0", so that `NODE_USE_ENV_PROXY=false`
// does not quietly buy silence from a machine that needs the sentence.
function nodeAlreadyUsesTheProxy(env: NodeJS.ProcessEnv): boolean {
  const flag = (env.NODE_USE_ENV_PROXY ?? '').trim().toLowerCase();
  if (flag.length > 0 && flag !== '0' && flag !== 'false' && flag !== 'no') return true;
  return (env.NODE_OPTIONS ?? '').includes('--use-env-proxy');
}

// Whether this target would travel through the proxy at all — the two exemptions
// Node itself applies, checked here so the advice matches what setting the
// variable would actually do.
//
// `NO_PROXY` is matched the way every tool that reads it matches: `*` exempts
// everything, and an entry is a host or a domain suffix, with an optional
// leading dot that means the same thing.
function goesThroughTheProxy(target: string, env: NodeJS.ProcessEnv): boolean {
  let host: string;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    // A server we cannot parse is one we cannot reason about. Silence is the
    // safe half of that, since the message it would join is already printed.
    return false;
  }

  // Measured, not assumed: Node tunnels loopback through the proxy like anything
  // else. Nobody's proxy has a route back to their own machine, so this is the
  // one place where following the advice makes a working setup fail.
  if (host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host)) return false;

  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '').trim();
  if (noProxy === '*') return false;
  return !noProxy
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/^\./, ''))
    .filter((entry) => entry.length > 0)
    .some((entry) => host === entry || host.endsWith(`.${entry}`));
}

// The major of a `v25.2.1`, or 0 when it is not a version string we can read —
// which reports "too old" and sends nobody to set a variable that may be inert.
function majorVersion(version: string): number {
  const major = /^v?(\d+)\./.exec(version.trim());
  return major ? Number(major[1]) : 0;
}

// The proxy as it is safe to print: the address, never the credentials.
//
// A proxy URL is one of the last places a password is still written in plain
// text, and this sentence ends up in terminals, transcripts and bug reports. The
// address is the part that helps somebody recognise which proxy this is; the
// credentials never are.
//
// Null when the value does not parse as a URL. Then it still means "this machine
// has a proxy" — worth saying — but nothing in it can be echoed, because a
// password cannot be found in a string whose shape we could not read.
function withoutCredentials(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.username.length === 0 && url.password.length === 0) return value;
  url.username = '';
  url.password = '';
  return url.toString();
}
