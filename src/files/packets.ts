import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { graphNodes, methodNameOf } from '../surfaces/graph.ts';
import { assertUnitbobPath } from './artifactPath.ts';
import { surfacesPath } from './mapBuild.ts';
import type { SuiteBuildRequest } from './suiteBuild.ts';

// Spec 37-1. A worker used to receive names — `User#get_token`, `POST /api/tokens` —
// and spend its first two thirds finding the code behind them. On microblog,
// 2026-08-23, that was 474 of 674 worker turns and 63% of their input, once per
// worker, for an application whose entire source is 92 KB.
//
// Resolving a name to a file is a dictionary lookup against two artifacts that
// are already on this machine, so it costs no tokens and asks no model. What it
// finds is copied whole: the packet carries exactly what the worker would have
// opened anyway, which is why it cannot inflate a run.
//
// Nothing here goes up the wire. Spec 22 keeps the source on the vibecoder's
// machine, and a packet is a local file the worker opens by path.
export const PACKETS_DIR = '.unitbob/suite-build/packets';

// The fuse, not a setting. It exists for the five-thousand-line controller
// whose file is not "what a worker would have read anyway" — there the packet
// carries the path and says so, and the worker opens the part it needs. There
// is nowhere for this number to live except this source file: the size of a
// packet is not a fact about the project, it is a fact about what fits.
export const MAX_PACKET_BYTES = 200_000;

export interface PacketTarget {
  branch: string;
  // The interface or capability this entrypoint belongs to, so a worker plan
  // item can be matched to its packets by the ids it already carries.
  id: string;
  entrypoint: string;
  source_file?: string;
  packet?: string;
  bytes?: number;
  // Words, whenever there is no packet. An empty packet that says nothing sends
  // the worker looking without telling it why it has to.
  note?: string;
}

export interface PacketIndex {
  targets: PacketTarget[];
}

export interface SuitePacketsSummary {
  targets: number;
  // Entrypoints whose file is known — including the few whose contents did not
  // travel. Knowing which file to open is most of what the search was for.
  located: number;
  resolved: number;
  files: number;
  bytes: number;
  // One line per reason, already in words, for the notice suite-prepare prints.
  notes: string[];
}

export function packetsDir(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'suite-build', 'packets');
}

export function packetIndexPath(projectRoot: string): string {
  return join(packetsDir(projectRoot), 'index.json');
}

export function readPacketIndex(projectRoot: string): PacketIndex | null {
  const path = packetIndexPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PacketIndex;
    if (!Array.isArray(parsed?.targets)) return null;
    // Entries, not just the array: a hand-edited index must not throw out of a
    // verb whose whole policy is that a bad index costs the packets and nothing
    // else.
    return { targets: parsed.targets.filter((target) => !!asRecord(target) && asString(target?.id) !== undefined) };
  } catch {
    // A packet index we cannot read is the same as none: the worker searches,
    // as it did before this spec. It is never a reason to fail a build.
    return null;
  }
}

// Build every packet for this request. Called right after `request.json` is
// written, and before any plan exists: the entrypoints are known from the
// request, the workers are not, so a packet belongs to an entrypoint and two
// entrypoints in one file share one packet.
export function writeSuitePackets(projectRoot: string, request: SuiteBuildRequest): SuitePacketsSummary {
  const targets = targetsOf(request);
  const lookup = buildLookup(projectRoot);
  const notes = new Map<string, number>();

  // Regenerated whole, every run. A packet left over from a previous assignment
  // sits under an authoritative name with nothing on it saying how old it is.
  const dir = packetsDir(projectRoot);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const written = new Map<string, number>();
  const refused = new Map<string, Refusal>();
  for (const target of targets) {
    const sourceFile = lookup(target.entrypoint);
    if (!sourceFile) {
      target.note = 'no single file in graph.json or surfaces.json answers to this name — find it yourself';
      count(notes, 'did not resolve to one file');
      continue;
    }

    // The path travels even when the contents do not: a worker told which file
    // to open has still been saved the search.
    target.source_file = sourceFile;
    // Two entrypoints in one file get one packet, written once, referenced twice.
    if (!written.has(sourceFile) && !refused.has(sourceFile)) {
      const copied = copyPacket(projectRoot, sourceFile);
      if (typeof copied === 'number') written.set(sourceFile, copied);
      else refused.set(sourceFile, copied);
    }

    const bytes = written.get(sourceFile);
    if (bytes === undefined) {
      const refusal = refused.get(sourceFile)!;
      target.note = refusal.note;
      // The size travels even when the contents do not, so spec 37-3 can weigh
      // this entrypoint. `packet` stays unset: there is still nothing to open
      // under the packets folder, and every reader keys off that, not off size.
      if (refusal.bytes !== undefined) target.bytes = refusal.bytes;
      count(notes, refusal.kind);
      continue;
    }
    target.packet = `${PACKETS_DIR}/${sourceFile}`;
    target.bytes = bytes;
  }

  writeFileSync(packetIndexPath(projectRoot), `${JSON.stringify({ targets }, null, 2)}\n`);

  return {
    targets: targets.length,
    located: targets.filter((target) => target.source_file).length,
    resolved: targets.filter((target) => target.packet).length,
    files: written.size,
    bytes: [...written.values()].reduce((sum, bytes) => sum + bytes, 0),
    notes: [...notes].map(([note, count]) => `${count} × ${note}`),
  };
}

// The two names a request carries. Structural interfaces name methods
// (`User#get_token`); behavioral capabilities name addresses (`POST /api/tokens`).
// Both are entrypoints, both resolve to a file, and both produce the same kind
// of packet — a worker on either branch opens the same thing the same way.
function targetsOf(request: SuiteBuildRequest): PacketTarget[] {
  const targets: PacketTarget[] = [];
  for (const branch of request.branches) {
    const assignment = branch.assignment as Record<string, unknown> | undefined;

    for (const block of asArray(assignment?.blocks)) {
      for (const iface of asArray(asRecord(block)?.interfaces)) {
        const record = asRecord(iface);
        const id = asString(record?.interface_id);
        if (!id) continue;
        for (const entrypoint of asArray(record?.entrypoints)) {
          const name = asString(entrypoint);
          if (name) targets.push({ branch: branch.suite_kind, id, entrypoint: name });
        }
      }
    }

    for (const capability of asArray(assignment?.capabilities)) {
      const record = asRecord(capability);
      const id = asString(record?.capability_id);
      if (!id) continue;
      for (const surface of asArray(record?.surfaces)) {
        const name = asString(surface);
        if (name) targets.push({ branch: branch.suite_kind, id, entrypoint: name });
      }
    }
  }
  return targets;
}

// One name in, at most one file out. Two local artifacts answer, both of them
// built from the graph rather than from anybody's spelling rule:
//
//   `surfaces.json` — the addresses the router declared, each already carrying
//   the file that serves it. It answers a behavioral surface (`POST /api/tokens`)
//   by its id and a structural entrypoint (`MainRoutes.export_posts`) by the
//   handler label, which is the router's own wording, not a name we built.
//
//   `graph.json` — every symbol graphify saw, matched by method name. A name
//   alone is not enough: `User#get_token` and `ApiTokens.get_token` are two
//   different entrypoints and graphify saw only one `get_token()`. So the owner
//   the entrypoint named has to agree with the file before it is believed.
//
// Ambiguity ends in silence, never in a first match, and neither does a name
// that resolves to a file its owner has nothing to do with. A packet holding
// the wrong file is worse than no packet: the worker reads it, believes it, and
// writes a test about code that does not serve this entrypoint. On microblog,
// 2026-08-23, matching on the bare name alone sent both `ApiTokens` entrypoints
// to `app/models.py`, whose `get_token` belongs to `User`.
function buildLookup(projectRoot: string): (entrypoint: string) => string | undefined {
  const byAddress = new Map<string, Set<string>>();
  for (const surface of readSurfaces(projectRoot)) {
    const record = asRecord(surface);
    const file = normalisePath(asString(record?.source_file));
    if (!file) continue;
    for (const key of [asString(record?.id), asString(record?.handler_label)]) {
      if (key) remember(byAddress, key, file);
    }
  }

  const byMethod = new Map<string, Set<string>>();
  const byLabel = new Map<string, Set<string>>();
  for (const node of graphNodes(projectRoot)) {
    const file = normalisePath(typeof node.source_file === 'string' ? node.source_file : undefined);
    if (typeof node.label !== 'string' || !file) continue;
    remember(byMethod, methodNameOf(node.label), file);
    remember(byLabel, node.label, file);
  }

  // The owner and the file agree if graphify put something of the owner's name
  // in that file, or if the owner is the file — `ApiAuth` and `app/api/auth.py`
  // are the same thing said twice, once in the map's words and once in the
  // filesystem's. This confirms a file we already found; it never builds a path
  // out of a name, which would be us maintaining somebody else's naming rule.
  const agrees = (owner: string, file: string): boolean =>
    byLabel.get(owner)?.has(file) === true ||
    byMethod.get(owner)?.has(file) === true ||
    squash(file).includes(squash(owner));

  return (entrypoint) => {
    const declared = only(byAddress.get(entrypoint));
    if (declared) return declared;

    // An address is the router's word, not a symbol, and must not fall through
    // to symbol matching: `GET /users` would resolve by the name `users` to
    // whatever single thing answers to it — a helper, a model, anything.
    if (/\s/.test(entrypoint)) return undefined;

    const named = byMethod.get(methodNameOf(entrypoint));
    if (!named) return undefined;

    const owner = ownerNameOf(entrypoint);
    if (!owner) return only(named);
    return only(new Set([...named].filter((file) => agrees(owner, file))));
  };
}

// The name the entrypoint hangs its method on: `User` in `User#get_token`,
// `Invoice` in `Billing::Invoice#total`. Split exactly as `methodNameOf` splits,
// so the two never disagree about where a name ends.
function ownerNameOf(entrypoint: string): string | undefined {
  const parts = entrypoint.replace(/\(.*\)\s*$/, '').split(/::|[#./]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : undefined;
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// graphify writes a path the way its host does. `app\models.rb` and
// `./app/models.rb` are the same file as `app/models.rb`, and treating them as
// three keys makes one file look like three and one method look ambiguous.
function normalisePath(value: string | undefined): string | undefined {
  const normalised = value?.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalised || undefined;
}

function remember(into: Map<string, Set<string>>, key: string, file: string): void {
  const seen = into.get(key) ?? new Set<string>();
  seen.add(file);
  into.set(key, seen);
}

function count(notes: Map<string, number>, note: string): void {
  notes.set(note, (notes.get(note) ?? 0) + 1);
}

function only(files: Set<string> | undefined): string | undefined {
  return files && files.size === 1 ? [...files][0] : undefined;
}

function readSurfaces(projectRoot: string): unknown[] {
  const path = surfacesPath(projectRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { surfaces?: unknown };
    return asArray(parsed?.surfaces);
  } catch {
    return [];
  }
}

// Why one file got no packet: the words that go on every target pointing at it,
// and the short kind those words are counted under in the run's summary. Two
// hundred missing files must not print two hundred sentences.
interface Refusal {
  note: string;
  kind: string;
  // The file's size when we know it, even though no copy was made. Spec 37-3
  // measures the fan-out from these bytes, and a file refused for being large
  // is the largest work there is — counting it as nothing would let the biggest
  // sources argue for the fewest workers.
  bytes?: number;
}

// Copy one source file into the packets folder, keeping the path it has in the
// checkout so the worker recognises it. Returns the byte count, or why there is
// no copy to make. It never throws: one unreadable file out of a hundred is one
// worker searching, not a run without packets.
function copyPacket(projectRoot: string, sourceFile: string): number | Refusal {
  const relative = `${PACKETS_DIR}/${sourceFile}`;
  try {
    assertUnitbobPath(relative, PACKETS_DIR);
  } catch {
    return {
      note: `graph.json names a path we will not write (${sourceFile}) — find the file yourself`,
      kind: 'named a path we will not write',
    };
  }

  try {
    // The path came from graphify's output, not from us. A symlink or an
    // absolute path there must not turn "copy a project file" into "copy
    // anything on this machine", so the file is required to really live inside
    // the checkout. `realpathSync` resolves every component, so a symlinked
    // directory in the middle of the path is caught the same way.
    const root = realpathSync(projectRoot);
    let onDisk: string;
    try {
      onDisk = realpathSync(resolve(projectRoot, sourceFile));
    } catch {
      return {
        note: `${sourceFile} is named in graph.json but is not on disk — find the file yourself`,
        kind: 'named a file that is not on disk',
      };
    }
    if (onDisk !== root && !onDisk.startsWith(root + sep)) {
      return {
        note: `${sourceFile} resolves outside the project — find the file yourself`,
        kind: 'resolved outside the project',
      };
    }

    const stat = statSync(onDisk);
    // A directory passes the size check comfortably and then throws EISDIR on
    // read. Said here rather than caught below, so the words name the cause.
    if (!stat.isFile()) {
      return {
        note: `${sourceFile} is not a file — find the code yourself`,
        kind: 'named something that is not a file',
      };
    }
    if (stat.size > MAX_PACKET_BYTES) {
      return {
        note: `${sourceFile} is ${stat.size.toLocaleString('en-US')} bytes, over the ${MAX_PACKET_BYTES.toLocaleString('en-US')}-byte packet fuse — open it at that path instead`,
        kind: 'over the packet fuse — the path travels instead',
        bytes: stat.size,
      };
    }

    // The bytes we actually wrote, not the size we saw a moment ago.
    const body = readFileSync(onDisk);
    const destination = join(projectRoot, relative);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, body);
    return body.length;
  } catch (err) {
    return {
      note: `${sourceFile} could not be copied (${(err as Error).message}) — find the file yourself`,
      kind: 'could not be copied',
    };
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
