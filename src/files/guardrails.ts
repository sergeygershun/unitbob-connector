import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SuiteBlob {
  suite_digest: string;
  spec_rb: string;
  manifest: unknown;
}

export const GUARDRAILS_DIR = join('.unitbob', 'guardrails');
export const SUITE_FILE = 'architecture_map_contracts_spec.rb';
export const MANIFEST_FILE = 'guardrails_manifest.json';

export function materializeGuardrails(projectRoot: string, suite: SuiteBlob): { suitePath: string } {
  const dir = join(projectRoot, GUARDRAILS_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const suitePath = join(dir, SUITE_FILE);
  writeFileSync(suitePath, suite.spec_rb);
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(suite.manifest, null, 2)}\n`);

  return { suitePath };
}
