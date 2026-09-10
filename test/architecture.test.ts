// Architecture guard (spec 15, acceptance criteria). The connector is "pure
// hands": it runs tools, relays opaque blobs over the wire, and prints what the
// server returns. It must never grow domain logic — reading the manifest,
// mapping pass/fail to contract elements, projecting a map, assembling a suite,
// or computing lamps. This test fails the build if such concepts appear in src/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

// Domain-interpretation tokens that have no business in a pure relay. Naming any
// of these means the connector started reasoning about Rails' job.
const FORBIDDEN = [
  /manifest/i,
  /contract[_-]?element/i,
  /\bcovered\b/i,
  /\bunguarded\b/i,
  /\bretired\b/i,
  /\bcoverage\b/i,
];
// Spec 30 reintroduced one narrow envelope field: `runner_manifest`, the
// suite-level runner selection whose `runner` enum names a connector-owned
// strategy. Carrying and relaying it is transport, not interpretation — the
// connector still never reads test results or maps pass/fail to contracts.
// Only the files that store, relay, or dispatch on that envelope may name it.
//
// `runner/manifest.ts` and `verbs/suitePrepare.ts` join them for the same
// reason. The envelope's valid combinations live on Rails, in the models that
// validate them, and ride down inside the assignment packet. The connector
// selects one by the `runner` strategy name it owns and will execute, and adds
// the version it just installed into the sidecar — storing and relaying, with
// the authoring still on the server side. It may not author an entry, which is
// why no table of languages or result formats appears in either file.
const ALLOWED_BY_FILE: Record<string, RegExp[]> = {
  // `wire.ts` types the response shape it relays, `unguarded_by_review` and all
  // (spec one-place-per-rule, §7). Typing a field is transport; the connector never computes one.
  'wire.ts': [/manifest/i, /\bunguarded\b/i],
  [join('files', 'guardrails.ts')]: [/manifest/i],
  [join('files', 'suiteBuild.ts')]: [/manifest/i],
  [join('runner', 'manifest.ts')]: [/manifest/i],
  [join('files', 'suiteBuildUpload.ts')]: [/manifest/i],
  [join('verbs', 'run.ts')]: [/manifest/i],
  [join('verbs', 'suitePrepare.ts')]: [/manifest/i],
  [join('verbs', 'validateBuild.ts')]: [/manifest/i],

  // a2time, 2026-08-17. `validate-worker-checkpoints` gates the shape of a local
  // scratch file that passes from a worker to the coordinator, and that file now
  // carries `surface_coverage`: the Scenario names a worker wrote and the
  // addresses its steps drive. The gate asks three mechanical questions — is the
  // capability one this plan item was given, is the Scenario named, is there at
  // least one surface — and it is the same kind of check the neighbouring
  // `facts` and `owned_paths` already get.
  //
  // An exemption is a word let into a file, not a word let into one line — the
  // guard matches text, and cannot tell the field from a variable named after it.
  // So the narrowness is in what stays forbidden: `covered`, `unguarded` and
  // `retired` still fail here, and the day this file starts deciding *which*
  // capabilities are covered — the server's job, and the rule spec one-place-per-rule tore out of
  // `validateBuild.ts` — the guard fires again.
  //
  // Spec 41, criterion 1 widened what the gate asks, and the widening is written
  // here because that is where this repo argues with itself. The slice now also
  // answers with `unreachable_surfaces`, and the gate asks two more mechanical
  // questions of it: is this address one the request gave *this slice*, and is it
  // claimed as driven and unreachable at once. Neither is a copy of a server rule
  // — the server has no idea slices exist, so it can only ask whether an address
  // belongs to the capability, never whether it belongs to the worker that named
  // it. And what a slice did *not* take is deliberately not asked here at all:
  // that is the arithmetic this guard turned back when it was first written into
  // `suiteBuildUpload.ts`, and it lives on Rails.
  [join('verbs', 'validateWorkerCheckpoints.ts')]: [/\bcoverage\b/i],

  // Spec 43, §7. `put-suite-build` prints the server's own `unguarded_by_review`
  // list: capabilities the publish stored unguarded because the review objected
  // to every Scenario guarding them. Relaying the server's words is what this
  // command is for, and the alternative — silence, because the word is
  // reserved — leaves the run to find it on the map instead.
  [join('verbs', 'putSuiteBuild.ts')]: [/manifest/i, /\bunguarded\b/i],
};

// Spec 32-6 Phase 3 gave `validateBuild.ts` a standing exemption for `covered`,
// `unguarded` and `coverage`: it held a local copy of the server's rules and had
// to name what it was comparing. Spec 43 deleted that copy — the command asks
// the server for a dry run instead of predicting its verdict — so the exemption
// went with it, and its absence above is now the guard. Those words reappearing
// in that file mean a second implementation of a server rule has started growing
// back.

// Spec 34-6, criterion 3 widened what a connector file may read, and this is the
// written line, in the same place 32-5 and 32-6 wrote theirs.
//
// `runner/failureDigest.ts` reads runner reports and sorts each case into passed
// or not. Its neighbour `boundReport.ts` deliberately does not — "Rails owns
// every bit of their interpretation" — and that stays true of everything that
// travels. What the digest produces travels nowhere: it is hashed, compared with
// the same branch's previous run, and reaches exactly one exit code. It joins
// nothing to the map, mints no marker, and its answer is never uploaded, printed
// as a verdict, or read by the server.
//
// So the rule below is unchanged and needs no new exemption: a connector file
// may look at a report to answer a question about *this machine's loop*, never
// to answer one about the product. If a later change wants the digest's opinion
// to leave the process, that is the moment this paragraph stops covering it.

// `lamp` is the single domain noun the connector may name — but only in wire.ts,
// where "lamps" is the URL of an opaque endpoint it fetches and prints verbatim.
// Anywhere else, naming a lamp means reasoning about one.
const LAMP = /lamp/i;
const WIRE_FILE = 'wire.ts';

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

test('connector src holds no domain-interpretation logic', () => {
  for (const file of tsFiles(srcDir)) {
    const rel = relative(srcDir, file);
    const text = readFileSync(file, 'utf8');

    for (const pattern of FORBIDDEN) {
      if (ALLOWED_BY_FILE[rel]?.some((allowed) => allowed.source === pattern.source)) continue;

      assert.ok(
        !pattern.test(text),
        `${rel} references forbidden domain concept ${pattern} — that logic belongs on Rails.`,
      );
    }

    if (rel !== WIRE_FILE) {
      assert.ok(
        !LAMP.test(text),
        `${rel} names "lamp"; only ${WIRE_FILE} may name the /lamps endpoint it relays.`,
      );
    }
  }
});
