import type { Config } from '../config.ts';
import { materializeGuardrails, type SuiteBlob } from '../files/guardrails.ts';
import { runRspecSuite, type RspecRunResult } from '../runner/rspec.ts';
import { Wire, type RunSummary } from '../wire.ts';

interface Deps {
  getSuite: () => Promise<SuiteBlob | null>;
  postRun: (payload: unknown) => Promise<RunSummary>;
  materializeGuardrails: (projectRoot: string, suite: SuiteBlob) => { suitePath: string };
  runRspecSuite: (projectRoot: string) => Promise<RspecRunResult>;
  stdout: { write: (chunk: string) => unknown };
}

export async function run(config: Config, _args: string[], deps?: Partial<Deps>): Promise<void> {
  const wire = new Wire(config);
  const d: Deps = {
    getSuite: () => wire.getSuite(),
    postRun: (payload) => wire.postRun(payload),
    materializeGuardrails,
    runRspecSuite,
    stdout: process.stdout,
    ...deps,
  };

  const suite = await d.getSuite();
  if (suite === null) {
    d.stdout.write('No Unitbob suite exists yet. Generate the test suite first, then run /unitbob check again.\n');
    return;
  }

  d.materializeGuardrails(config.projectRoot, suite);

  const result =
    await d.runRspecSuite(config.projectRoot).catch((err) => ({
      stdout: '',
      stderr: (err as Error).message,
      code: null,
      command: 'rspec',
      args: [],
    }));

  const payload = rawRunPayload(suite.suite_digest, result);
  const summary = await d.postRun(payload);
  d.stdout.write(`${summary.summary}\n`);
  if (summary.map_url) d.stdout.write(`${summary.map_url}\n`);
}

function rawRunPayload(suiteDigest: string, result: RspecRunResult): unknown {
  const parsed = parseJsonObject(result.stdout);
  if (parsed) return { suite_digest: suiteDigest, rspec_json: parsed };

  return {
    suite_digest: suiteDigest,
    suite_error: suiteErrorMessage(result),
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function suiteErrorMessage(result: RspecRunResult): string {
  const bits: string[] = [];
  if (result.code !== 0 && result.code !== null) bits.push(`exit ${result.code}`);
  if (result.stderr.trim()) bits.push(`stderr: ${result.stderr.trim()}`);
  if (result.stdout.trim()) bits.push(`stdout: ${result.stdout.trim().slice(0, 1000)}`);
  return bits.length > 0 ? bits.join(' | ') : 'RSpec output was not parseable JSON';
}
