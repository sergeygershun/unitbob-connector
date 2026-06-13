import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FixPacket } from '../wire.ts';

// The task the host reads to repair local code (spec 21). It carries the
// per-error substance — the business headline, the RSpec body (shown so it is
// respected, never weakened), the latest failure, and a source anchor — plus the
// project root the host reads its own source from. There is **no** output file:
// the host edits code in place, and the next `/unitbob check` shows the result.
export interface FixRequest {
  project_root: string;
  test_id: string;
  headline: string;
  test_body: string;
  failure_message: string;
  anchor: string | null;
}

export function requestPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'fix', 'request.json');
}

export function writeFixRequest(projectRoot: string, testId: string, packet: FixPacket): FixRequest {
  const request: FixRequest = {
    project_root: projectRoot,
    test_id: testId,
    headline: packet.headline,
    test_body: packet.test_body,
    failure_message: packet.failure_message,
    anchor: packet.anchor,
  };

  const path = requestPath(projectRoot);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}
