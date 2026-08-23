import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  MAX_PACKET_BYTES,
  PACKETS_DIR,
  packetIndexPath,
  readPacketIndex,
  writeSuitePackets,
} from '../src/files/packets.ts';
import type { SuiteBuildRequest } from '../src/files/suiteBuild.ts';

// Spec 37-1. The packet is what the worker would have gone looking for, put
// where it can open it without looking. Every test here is one line of the
// acceptance criteria; the ones about silence matter most, because a packet
// holding the wrong file is worse than no packet at all.

function project(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-packets-'));
}

function write(projectRoot: string, path: string, body: string): void {
  const full = join(projectRoot, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function graph(projectRoot: string, nodes: Array<Record<string, unknown>>): void {
  write(projectRoot, 'graphify-out/graph.json', JSON.stringify({ nodes, links: [] }));
}

function surfaces(projectRoot: string, entries: Array<Record<string, unknown>>): void {
  write(projectRoot, '.unitbob/map-build/surfaces.json', JSON.stringify({ surfaces: entries }));
}

function request(branches: SuiteBuildRequest['branches']): SuiteBuildRequest {
  return {
    project_root: '/does/not/matter',
    output_path: '/does/not/matter/suite_output.json',
    branches,
    known_defect_context: { status: 'not_supplied' },
  };
}

function structural(blocks: unknown): SuiteBuildRequest['branches'][number] {
  return {
    suite_kind: 'structural',
    source_digest: 'sha256:x',
    path_root: '.unitbob/structural/',
    recipe: { name: 'structural', version: '1', text: '' },
    assignment: { blocks },
  };
}

function behavioral(capabilities: unknown): SuiteBuildRequest['branches'][number] {
  return {
    suite_kind: 'behavioral',
    source_digest: 'sha256:y',
    path_root: '.unitbob/behavioral/',
    recipe: { name: 'behavioral', version: '1', text: '' },
    assignment: { capabilities },
  };
}

function block(interfaceId: string, entrypoints: string[]): Record<string, unknown> {
  return {
    block_id: 'b1',
    block_name: 'Block',
    interfaces: [{ interface_id: interfaceId, name: interfaceId, entrypoints }],
  };
}

test('a structural entrypoint resolves through the graph and its whole file becomes the packet', () => {
  const root = project();
  write(root, 'app/models.py', 'class User:\n    def get_token(self):\n        return 1\n');
  graph(root, [
    { id: 'n0', label: 'User', source_file: 'app/models.py' },
    { id: 'n1', label: 'get_token()', source_file: 'app/models.py' },
  ]);

  const summary = writeSuitePackets(root, request([structural([block('i1', ['User#get_token'])])]));

  assert.equal(summary.resolved, 1);
  assert.equal(summary.files, 1);
  const target = readPacketIndex(root)!.targets[0]!;
  assert.equal(target.packet, `${PACKETS_DIR}/app/models.py`);
  assert.equal(target.source_file, 'app/models.py');
  assert.equal(target.branch, 'structural');
  assert.equal(target.id, 'i1');
  // The file whole, byte for byte — not an extract, not a summary.
  assert.equal(
    readFileSync(join(root, target.packet!), 'utf8'),
    readFileSync(join(root, 'app/models.py'), 'utf8'),
  );
  assert.equal(target.bytes, readFileSync(join(root, 'app/models.py')).length);
});

test('two entrypoints in one file share one packet, written once', () => {
  const root = project();
  write(root, 'app/models.py', 'class User: pass\n');
  graph(root, [
    { id: 'n0', label: 'User', source_file: 'app/models.py' },
    { id: 'n1', label: 'get_token()', source_file: 'app/models.py' },
    { id: 'n2', label: 'revoke_token()', source_file: 'app/models.py' },
  ]);

  const summary = writeSuitePackets(
    root,
    request([structural([block('i1', ['User#get_token', 'User#revoke_token'])])]),
  );

  assert.equal(summary.targets, 2);
  assert.equal(summary.resolved, 2);
  assert.equal(summary.files, 1, 'one file, one packet');
  const targets = readPacketIndex(root)!.targets;
  assert.equal(targets[0]!.packet, targets[1]!.packet);
  assert.equal(summary.bytes, readFileSync(join(root, 'app/models.py')).length);
});

test('a behavioral surface resolves through surfaces.json to the same shape of packet', () => {
  const root = project();
  write(root, 'app/api/tokens.py', '@bp.route("/api/tokens")\ndef post_token(): pass\n');
  graph(root, []);
  surfaces(root, [
    { kind: 'route', id: 'POST /api/tokens', source_file: 'app/api/tokens.py', handler_label: 'Tokens.post' },
  ]);

  writeSuitePackets(
    root,
    request([behavioral([{ capability_id: 'api-access-tokens', surfaces: ['POST /api/tokens'] }])]),
  );

  const target = readPacketIndex(root)!.targets[0]!;
  assert.equal(target.branch, 'behavioral');
  assert.equal(target.id, 'api-access-tokens');
  assert.equal(target.packet, `${PACKETS_DIR}/app/api/tokens.py`);
});

test('the router-declared handler label answers a structural entrypoint the graph cannot place', () => {
  const root = project();
  write(root, 'app/main/routes.py', 'def export_posts(): pass\n');
  write(root, 'app/tasks.py', 'def export_posts(): pass\n');
  // Two files hold a method of that name, so the graph alone must stay silent.
  graph(root, [
    { id: 'n1', label: 'export_posts()', source_file: 'app/main/routes.py' },
    { id: 'n2', label: 'export_posts()', source_file: 'app/tasks.py' },
  ]);
  surfaces(root, [
    { kind: 'route', id: 'GET /export', source_file: 'app/main/routes.py', handler_label: 'MainRoutes.export_posts' },
  ]);

  writeSuitePackets(root, request([structural([block('i1', ['MainRoutes.export_posts'])])]));

  assert.equal(readPacketIndex(root)!.targets[0]!.packet, `${PACKETS_DIR}/app/main/routes.py`);
});

test('an ambiguous name gets no packet and says so in words', () => {
  const root = project();
  write(root, 'app/translate/api.py', 'def translate(): pass\n');
  write(root, 'app/translate/legacy.py', 'def translate(): pass\n');
  graph(root, [
    { id: 'n1', label: 'translate()', source_file: 'app/translate/api.py' },
    { id: 'n2', label: 'translate()', source_file: 'app/translate/legacy.py' },
  ]);

  const summary = writeSuitePackets(root, request([structural([block('i1', ['Translate.translate'])])]));

  const target = readPacketIndex(root)!.targets[0]!;
  assert.equal(target.packet, undefined);
  assert.equal(target.source_file, undefined);
  assert.match(target.note!, /find it yourself/);
  assert.equal(summary.resolved, 0);
  assert.deepEqual(summary.notes, ['1 × did not resolve to one file']);
});

test('the class part narrows an ambiguous method name to one file', () => {
  const root = project();
  write(root, 'app/models.py', 'class User:\n    def to_dict(self): pass\n');
  write(root, 'app/tasks.py', 'def to_dict(): pass\n');
  graph(root, [
    { id: 'n1', label: 'to_dict()', source_file: 'app/models.py' },
    { id: 'n2', label: 'to_dict()', source_file: 'app/tasks.py' },
    { id: 'n3', label: 'User', source_file: 'app/models.py' },
  ]);

  writeSuitePackets(root, request([structural([block('i1', ['User#to_dict'])])]));

  assert.equal(readPacketIndex(root)!.targets[0]!.packet, `${PACKETS_DIR}/app/models.py`);
});

test('a file over the fuse travels as a path, and the packet says why', () => {
  const root = project();
  write(root, 'app/huge.py', 'x = 1\n'.repeat(MAX_PACKET_BYTES));
  graph(root, [{ id: 'n1', label: 'create()', source_file: 'app/huge.py' }]);

  const summary = writeSuitePackets(root, request([structural([block('i1', ['Huge#create'])])]));

  const target = readPacketIndex(root)!.targets[0]!;
  assert.equal(target.packet, undefined);
  assert.equal(target.source_file, 'app/huge.py', 'the path still travels');
  assert.match(target.note!, /over the .* packet fuse — open it at that path instead/);
  assert.equal(summary.files, 0);
  assert.equal(existsSync(join(root, PACKETS_DIR, 'app/huge.py')), false);
});

test('a source_file that resolves outside the checkout is refused, not copied', () => {
  const root = project();
  const outside = project();
  writeFileSync(join(outside, 'secret.py'), 'TOKEN = "no"\n');
  mkdirSync(join(root, 'app'), { recursive: true });
  symlinkSync(join(outside, 'secret.py'), join(root, 'app', 'leak.py'));
  graph(root, [{ id: 'n1', label: 'leak()', source_file: 'app/leak.py' }]);

  writeSuitePackets(root, request([structural([block('i1', ['Leak#leak'])])]));

  const target = readPacketIndex(root)!.targets[0]!;
  assert.equal(target.packet, undefined);
  assert.match(target.note!, /resolves outside the project/);
  assert.equal(existsSync(join(root, PACKETS_DIR, 'app/leak.py')), false);
});

test('a file named in the graph but missing on disk is refused in words', () => {
  const root = project();
  graph(root, [{ id: 'n1', label: 'gone()', source_file: 'app/gone.py' }]);

  writeSuitePackets(root, request([structural([block('i1', ['Gone#gone'])])]));

  assert.match(readPacketIndex(root)!.targets[0]!.note!, /is not on disk/);
});

test('every run rebuilds the folder, so no packet outlives its assignment', () => {
  const root = project();
  write(root, 'app/models.py', 'class User: pass\n');
  graph(root, [
    { id: 'n0', label: 'User', source_file: 'app/models.py' },
    { id: 'n1', label: 'get_token()', source_file: 'app/models.py' },
  ]);
  write(root, `${PACKETS_DIR}/app/gone_last_run.py`, 'stale\n');

  writeSuitePackets(root, request([structural([block('i1', ['User#get_token'])])]));

  assert.equal(existsSync(join(root, PACKETS_DIR, 'app/gone_last_run.py')), false);
  assert.equal(existsSync(join(root, PACKETS_DIR, 'app/models.py')), true);
});

test('no graph and no surfaces is a run with no packets, not a failed build', () => {
  const root = project();

  const summary = writeSuitePackets(root, request([structural([block('i1', ['User#get_token'])])]));

  assert.equal(summary.targets, 1);
  assert.equal(summary.resolved, 0);
  assert.equal(existsSync(packetIndexPath(root)), true);
  assert.match(readPacketIndex(root)!.targets[0]!.note!, /find it yourself/);
});

test('an unreadable index reads as no index rather than throwing', () => {
  const root = project();
  write(root, `${PACKETS_DIR}/index.json`, '{ not json');

  assert.equal(readPacketIndex(root), null);
});

test('a name whose owner has nothing to do with the file gets no packet', () => {
  const root = project();
  write(root, 'app/models.py', 'class User:\n    def get_token(self): pass\n');
  write(root, 'app/api/tokens.py', 'def post(): pass\n');
  // Exactly one `get_token` in the graph, and it is User's. On microblog,
  // 2026-08-23, matching on the bare name sent `ApiTokens.get_token` to
  // app/models.py — a file that does not serve that entrypoint.
  graph(root, [
    { id: 'n0', label: 'User', source_file: 'app/models.py' },
    { id: 'n1', label: 'get_token()', source_file: 'app/models.py' },
  ]);

  writeSuitePackets(root, request([structural([block('i1', ['ApiTokens.get_token'])])]));

  const target = readPacketIndex(root)!.targets[0]!;
  assert.equal(target.packet, undefined);
  assert.match(target.note!, /find it yourself/);
});

test('the owner may be the file itself, not only a class inside it', () => {
  const root = project();
  write(root, 'app/api/auth.py', 'def verify_password(): pass\n');
  graph(root, [{ id: 'n1', label: 'verify_password()', source_file: 'app/api/auth.py' }]);

  writeSuitePackets(root, request([structural([block('i1', ['ApiAuth.verify_password'])])]));

  assert.equal(readPacketIndex(root)!.targets[0]!.packet, `${PACKETS_DIR}/app/api/auth.py`);
});

test('an address is never resolved by symbol name', () => {
  const root = project();
  write(root, 'app/helpers/user_helper.rb', 'def users; end\n');
  // The only `users` in this project is a view helper. Falling through from the
  // address to the symbol would hand the route that file with full confidence.
  graph(root, [{ id: 'n1', label: 'users()', source_file: 'app/helpers/user_helper.rb' }]);

  writeSuitePackets(root, request([behavioral([{ capability_id: 'c1', surfaces: ['GET /users'] }])]));

  assert.equal(readPacketIndex(root)!.targets[0]!.packet, undefined);
});

test('a graph path written with backslashes or a ./ prefix is the same file', () => {
  const root = project();
  write(root, 'app/models.py', 'class User: pass\n');
  graph(root, [
    { id: 'n0', label: 'User', source_file: './app/models.py' },
    { id: 'n1', label: 'get_token()', source_file: 'app\\models.py' },
  ]);

  const summary = writeSuitePackets(root, request([structural([block('i1', ['User#get_token'])])]));

  assert.equal(summary.files, 1);
  assert.equal(readPacketIndex(root)!.targets[0]!.packet, `${PACKETS_DIR}/app/models.py`);
});

test('one unreadable file costs its own packet and no other', () => {
  const root = project();
  write(root, 'app/good.py', 'def fine(): pass\n');
  mkdirSync(join(root, 'app', 'broken'), { recursive: true });
  // A directory passes the size check and then throws EISDIR on read. Before
  // this was caught, one such node threw past the loop and left the run with no
  // index and no packets at all.
  graph(root, [
    { id: 'n1', label: 'fine()', source_file: 'app/good.py' },
    { id: 'n2', label: 'broken()', source_file: 'app/broken' },
  ]);

  const summary = writeSuitePackets(root, request([structural([
    { block_id: 'b1', interfaces: [
      { interface_id: 'i1', entrypoints: ['fine'] },
      { interface_id: 'i2', entrypoints: ['broken'] },
    ] },
  ])]));

  assert.equal(summary.files, 1);
  assert.equal(existsSync(join(root, PACKETS_DIR, 'app/good.py')), true);
  assert.match(readPacketIndex(root)!.targets[1]!.note!, /is not a file/);
});

test('the fuse is a boundary, not a range', () => {
  const root = project();
  write(root, 'app/at.py', 'x'.repeat(MAX_PACKET_BYTES));
  write(root, 'app/over.py', 'x'.repeat(MAX_PACKET_BYTES + 1));
  graph(root, [
    { id: 'n1', label: 'at()', source_file: 'app/at.py' },
    { id: 'n2', label: 'over()', source_file: 'app/over.py' },
  ]);

  writeSuitePackets(root, request([structural([
    { block_id: 'b1', interfaces: [
      { interface_id: 'i1', entrypoints: ['at'] },
      { interface_id: 'i2', entrypoints: ['over'] },
    ] },
  ])]));

  const targets = readPacketIndex(root)!.targets;
  assert.equal(targets[0]!.bytes, MAX_PACKET_BYTES);
  assert.equal(targets[1]!.packet, undefined);
});

test('a packet is never named in the request, so the request digest is untouched', () => {
  const root = project();
  write(root, 'app/models.py', 'class User: pass\n');
  graph(root, [
    { id: 'n0', label: 'User', source_file: 'app/models.py' },
    { id: 'n1', label: 'get_token()', source_file: 'app/models.py' },
  ]);
  const built = request([structural([block('i1', ['User#get_token'])])]);
  const before = JSON.stringify(built);

  writeSuitePackets(root, built);

  // The coordinator reads request.json whole on every turn; source in there is
  // paid for again and again, and its bytes are the request_digest.
  assert.equal(JSON.stringify(built), before);
  assert.doesNotMatch(before, /class User/);
});

test('building a packet reaches no further than the local filesystem', () => {
  // Spec 22: the source stays on this machine. An import of the wire would be
  // the only way for a packet to leave it, so the absence of one is the check.
  const source = readFileSync(new URL('../src/files/packets.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

  assert.deepEqual(imports.sort(), [
    '../surfaces/graph.ts',
    './artifactPath.ts',
    './mapBuild.ts',
    './suiteBuild.ts',
    'node:fs',
    'node:path',
  ]);
});
