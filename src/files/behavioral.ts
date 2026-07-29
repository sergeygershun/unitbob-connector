import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

// Everything under the behavioral root that the next materialization will
// delete: it wipes every top-level entry outside the runner environment and
// writes back only the files the answer listed, so a step file the answer forgot
// is gone and its steps come back undefined — a harness break reported far from
// its cause. One file per capability makes forgetting one much easier than a
// single file for the whole product ever did.
//
// The whole root is walked, not just the directories the answer happens to use:
// the file most likely to be forgotten is the one in a directory the answer
// never mentions — `features/support/env.rb` is exactly that shape.
export function filesLostOnMaterialize(projectRoot: string, artifact: SuiteArtifact, runner: string): string[] {
  const behavioralRoot = join(projectRoot, BEHAVIORAL_DIR);
  if (!existsSync(behavioralRoot)) return [];

  const listed = new Set([artifact.path, ...(artifact.support_files ?? []).map((file) => file.path)]);
  const runnerEntries = RUNNER_ENVIRONMENT_ENTRIES[runner] ?? EMPTY_ENTRIES;

  return readdirSync(behavioralRoot)
    .filter((entry) => !runnerEntries.has(entry))
    .flatMap((entry) => filesUnder(projectRoot, `${BEHAVIORAL_DIR}/${entry}`))
    .filter((path) => !listed.has(path))
    .sort();
}

// The real files under `relative`. Symlinks are not followed: materialization
// removes the link, not what it points at, and naming the target here would read
// as a warning about a file that was never in danger.
function filesUnder(projectRoot: string, relative: string): string[] {
  const stats = lstatSync(join(projectRoot, relative));
  if (stats.isFile()) return [relative];
  if (!stats.isDirectory()) return [];

  return readdirSync(join(projectRoot, relative)).flatMap((entry) => filesUnder(projectRoot, `${relative}/${entry}`));
}

export function copyBehavioralRunnerEnvironment(
  sourceRoot: string,
  targetRoot: string,
  runner: string,
): void {
  const entries = RUNNER_ENVIRONMENT_ENTRIES[runner] ?? EMPTY_ENTRIES;
  for (const entry of entries) {
    const source = join(sourceRoot, BEHAVIORAL_DIR, entry);
    if (!existsSync(source)) continue;

    const target = join(targetRoot, BEHAVIORAL_DIR, entry);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
}

const EMPTY_ENTRIES = new Set<string>();
const RUNNER_ENVIRONMENT_ENTRIES: Record<string, ReadonlySet<string>> = {
  cucumber: new Set(['.bundle', 'Gemfile', 'Gemfile.lock']),
  'cucumber-js': new Set(['node_modules', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']),
  'pytest-bdd': new Set(['.venv']),
};
