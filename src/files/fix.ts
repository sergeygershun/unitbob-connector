import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FixPacket } from '../wire.ts';

// The task the host reads to act on one red guard (spec 26). It carries the
// per-capability substance — the business headline, the latest failure, a
// where-to-look anchor, the complete repair prompt, and the capability id — plus
// the project root the host reads its own source from. There is **no** test body:
// the whole spec file is already on disk at `.unitbob/guardrails/`. There is no
// output file for a fix: the host edits code in place, and the next `/unitbob
// check` shows the result. (For an accept, the host re-authors the capability and
// republishes via suite-build.)
export interface FixRequest {
  project_root: string;
  interface_id: string;
  headline: string;
  failure_message: string;
  anchor: string | null;
  prompt: string;
}

export function requestPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'fix', 'request.json');
}

export function writeFixRequest(projectRoot: string, interfaceId: string, packet: FixPacket): FixRequest {
  const request: FixRequest = {
    project_root: projectRoot,
    interface_id: interfaceId,
    headline: packet.headline,
    failure_message: packet.failure_message,
    anchor: packet.anchor,
    prompt: packet.prompt,
  };

  const path = requestPath(projectRoot);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}
