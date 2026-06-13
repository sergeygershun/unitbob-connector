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
