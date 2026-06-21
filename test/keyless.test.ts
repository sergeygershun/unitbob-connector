// Keyless guard (spec 25). The connector rents inference from the host-LLM; it
// must never need its own LLM key. No source path may read an API key, load a
// `.env`, or invoke graphify's old keyed `extract` mode — graph extraction is the
// deterministic `graphify update <root> --force` and nothing more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /_API_KEY/, why: 'reads an inference API key' },
  { pattern: /OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|ANTHROPIC_API_KEY/i, why: 'names a keyed LLM provider' },
  { pattern: /dotenv|['"`]\.env['"`]/i, why: 'loads a .env / inference secret' },
  { pattern: /['"]extract['"]/, why: "invokes graphify's old keyed extract mode" },
];

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

test('connector src never reads an API key, loads .env, or uses keyed extract', () => {
  for (const file of tsFiles(srcDir)) {
    const rel = relative(srcDir, file);
    const text = readFileSync(file, 'utf8');
    for (const { pattern, why } of FORBIDDEN) {
      assert.ok(!pattern.test(text), `${rel} ${why} (${pattern}) — connector graph extraction is keyless.`);
    }
  }
});
