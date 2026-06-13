import type { Config } from '../config.ts';
import { writeFixRequest } from '../files/fix.ts';
import { Wire, type FixPacket } from '../wire.ts';

interface FixPrepareDeps {
  getFixPacket: (testId: string) => Promise<FixPacket>;
  stdout: { write: (chunk: string) => unknown };
}

// Fetch **only** the per-test Fix data packet and write the host's task to
// `.unitbob/fix/request.json`. No recipe fetch, no upload, no output file — the
// host reads its own source and edits local code, then the next `/unitbob check`
// shows the result (spec 21). A 422 from the server (non-failed / stale / no
// suite) surfaces via WireError; nothing is written.
export async function fixPrepare(config: Config, args: string[] = [], deps?: Partial<FixPrepareDeps>): Promise<void> {
  const testId = (args[0] ?? '').trim();
  if (!testId) throw new Error('Usage: unitbob fix-prepare <test_id>');

  const d: FixPrepareDeps = {
    getFixPacket: (id) => new Wire(config).getFixPacket(id),
    stdout: process.stdout,
    ...deps,
  };

  const packet = await d.getFixPacket(testId);
  writeFixRequest(config.projectRoot, testId, packet);
  d.stdout.write(`${packet.message}\n`);
}
