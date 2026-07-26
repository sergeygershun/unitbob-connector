import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertUnitbobPath } from './artifactPath.ts';
import type { SuiteArtifact } from '../wire.ts';

// The behavioral suite lives under its own root: the main `.feature` plus its
// step definitions and any helper files, all under `.unitbob/behavioral/`
// (spec 32). Nothing here is ever written into the project's own `spec/`,
// `features/`, or `tests/`. Like the structural flow, the host LLM writes and
// runs the suite to green before upload; the connector materializes the stored
// blob only so `check` can execute it locally.
export const BEHAVIORAL_DIR = '.unitbob/behavioral';

// Write a behavioral artifact envelope (main file + support files) under the
// behavioral root, after checking every path is safe. Stale suite artifacts are
// removed while the separately provisioned runner environment is preserved.
// Returns the absolute path of the materialized main file.
export function materializeBehavioral(
  projectRoot: string,
  artifact: SuiteArtifact,
  runner: string,
): { mainPath: string } {
  const files = [artifact, ...(artifact.support_files ?? [])];
  for (const file of files) assertUnitbobPath(file.path, BEHAVIORAL_DIR);

  const behavioralRoot = join(projectRoot, BEHAVIORAL_DIR);
  const runnerEntries = RUNNER_ENVIRONMENT_ENTRIES[runner] ?? EMPTY_ENTRIES;
  mkdirSync(behavioralRoot, { recursive: true });
  for (const entry of readdirSync(behavioralRoot)) {
    if (!runnerEntries.has(entry)) {
      rmSync(join(behavioralRoot, entry), { recursive: true, force: true });
    }
  }

  let mainPath = '';
  for (const file of files) {
    const dest = join(projectRoot, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.content);
    if (file === artifact) mainPath = dest;
  }

  return { mainPath };
}

const EMPTY_ENTRIES = new Set<string>();
const RUNNER_ENVIRONMENT_ENTRIES: Record<string, ReadonlySet<string>> = {
  cucumber: new Set(['.bundle', 'Gemfile', 'Gemfile.lock']),
  'cucumber-js': new Set(['node_modules', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']),
  'pytest-bdd': new Set(['.venv']),
};
