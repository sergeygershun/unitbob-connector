import type { Config } from '../config.ts';
import { writeFixRequest } from '../files/fix.ts';
import { Wire, type FixPacket } from '../wire.ts';

interface FixPrepareDeps {
  getFixPacket: (interfaceId: string) => Promise<FixPacket>;
  stdout: { write: (chunk: string) => unknown };
}

// Fetch the per-capability repair packet and write the host's task to
// `.unitbob/fix/request.json`. No recipe fetch, no upload — the host reads its own
// source and the local spec file, then either fixes code (next `/unitbob check`
// shows the result) or accepts the change and republishes the suite (spec 26). A
// 422 from the server (non-failed / stale / no suite) surfaces via WireError;
// nothing is written.
export async function fixPrepare(config: Config, args: string[] = [], deps?: Partial<FixPrepareDeps>): Promise<void> {
  const interfaceId = (args[0] ?? '').trim();
  if (!interfaceId) throw new Error('Usage: unitbob fix-prepare <interface_id>');

  const d: FixPrepareDeps = {
    getFixPacket: (id) => new Wire(config).getFixPacket(id),
    stdout: process.stdout,
    ...deps,
  };

  const packet = await d.getFixPacket(interfaceId);
  writeFixRequest(config.projectRoot, interfaceId, packet);
  d.stdout.write(`${packet.message}\n`);
}
