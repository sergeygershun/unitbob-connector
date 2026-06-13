// Internal hands-verb for spec 17. It runs graphify locally, reads the raw
// graph.json, validates it is JSON, and sends that exact document to Rails.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { ensureUnitbobIgnored, requireGraphify, runGraphifyExtract } from '../proc.ts';
import { Wire } from '../wire.ts';

interface AnalyzeDeps {
  requireGraphify: () => Promise<void>;
  ensureUnitbobIgnored: (projectRoot: string) => void;
  runGraphifyExtract: (projectRoot: string) => Promise<{ stdout: string; stderr: string; code: number | null }>;
  putGraph: (rawGraphJson: string) => Promise<{ graph_digest: string }>;
}

export async function analyze(config: Config, _args: string[] = [], deps?: Partial<AnalyzeDeps>): Promise<void> {
  const actual: AnalyzeDeps = {
    requireGraphify,
    ensureUnitbobIgnored,
    runGraphifyExtract,
    putGraph: (graph) => new Wire(config).putGraph(graph),
    ...deps,
  };

  actual.ensureUnitbobIgnored(config.projectRoot);
  await actual.requireGraphify();

  const result = await actual.runGraphifyExtract(config.projectRoot);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `graphify exited ${result.code}`;
    throw new Error(`graphify extract failed: ${detail}`);
  }

  const graphPath = join(config.projectRoot, '.unitbob', 'graphify-out', 'graph.json');
  if (!existsSync(graphPath)) {
    throw new Error(`graphify extract did not write ${graphPath}`);
  }

  const rawGraphJson = readFileSync(graphPath, 'utf8');
  try {
    JSON.parse(rawGraphJson);
  } catch (err) {
    throw new Error(`${graphPath} is not valid JSON (${(err as Error).message})`);
  }

  const { graph_digest } = await actual.putGraph(rawGraphJson);
  process.stdout.write(
    `Graph uploaded (${graph_digest}). Full map build moves to /unitbob map in spec 19.\n`,
  );
}
