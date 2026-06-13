import type { Config } from '../config.ts';
import { writeReshapeRequest } from '../files/reshape.ts';
import { Wire, type ReshapePacket } from '../wire.ts';

interface ReshapePrepareDeps {
  getReshapePacket: (testId: string) => Promise<ReshapePacket>;
  stdout: { write: (chunk: string) => unknown };
}

// Fetch the bundled generate recipe + single-element packet + suite_digest and
// write the host's task to `.unitbob/reshape/request.json` (spec 21). The host
// then regenerates one test body; `put-reshape` runs and commits it. A 409 (the
// code is gone) surfaces via WireError carrying the server's "retire instead"
// guidance; nothing is written.
export async function reshapePrepare(config: Config, args: string[] = [], deps?: Partial<ReshapePrepareDeps>): Promise<void> {
  const testId = (args[0] ?? '').trim();
  if (!testId) throw new Error('Usage: unitbob reshape-prepare <test_id>');

  const d: ReshapePrepareDeps = {
    getReshapePacket: (id) => new Wire(config).getReshapePacket(id),
    stdout: process.stdout,
    ...deps,
  };

  const packet = await d.getReshapePacket(testId);
  const request = writeReshapeRequest(config.projectRoot, testId, packet);
  d.stdout.write(`Reshape request written to ${request.output_path.replace(/reshape_output\.json$/, 'request.json')}\n`);
}
