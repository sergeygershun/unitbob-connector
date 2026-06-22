import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The current suite blob the connector materializes and runs (spec 26). It is the
// exact host-written file bytes plus their digest — `test_metadata` stays
// server-side and never ships down for a check.
export interface SuiteBlob {
  suite_digest: string;
  spec_rb: string;
}

export const GUARDRAILS_DIR = join('.unitbob', 'guardrails');
export const SUITE_FILE = 'architecture_map_contracts_spec.rb';

export function materializeGuardrails(projectRoot: string, suite: SuiteBlob): { suitePath: string } {
  const dir = join(projectRoot, GUARDRAILS_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const suitePath = join(dir, SUITE_FILE);
  writeFileSync(suitePath, suite.spec_rb);

  return { suitePath };
}
