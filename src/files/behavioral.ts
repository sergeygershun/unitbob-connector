import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
// behavioral root, after checking every path is safe. The root is wiped first
// so a stale file from a previous version never lingers. Returns the absolute
// path of the materialized main file.
export function materializeBehavioral(projectRoot: string, artifact: SuiteArtifact): { mainPath: string } {
  const files = [artifact, ...(artifact.support_files ?? [])];
  for (const file of files) assertUnitbobPath(file.path, BEHAVIORAL_DIR);

  rmSync(join(projectRoot, BEHAVIORAL_DIR), { recursive: true, force: true });

  let mainPath = '';
  for (const file of files) {
    const dest = join(projectRoot, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.content);
    if (file === artifact) mainPath = dest;
  }

  return { mainPath };
}
