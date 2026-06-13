import { relative } from 'node:path';
import type { Config } from '../config.ts';
import { readReshapeOutput, readReshapeRequest, writeCandidateSpec } from '../files/reshape.ts';
import { runRspecExample, type RspecRunResult } from '../runner/rspec.ts';
import { Wire, type ReshapeCandidateResult, type ReshapeCommitResult } from '../wire.ts';

interface PutReshapeDeps {
  postReshapeCandidate: (payload: unknown) => Promise<ReshapeCandidateResult>;
  postReshapeCommit: (payload: unknown) => Promise<ReshapeCommitResult>;
  runExample: (projectRoot: string, specPath: string, testId: string) => Promise<RspecRunResult>;
  stdout: { write: (chunk: string) => unknown };
}

// Commit one reshaped test through the local gate (spec 21):
//   1. read the host's one new body — empty/missing throws, nothing uploaded (M2);
//   2. POST it to reshape_candidate; Rails assembles the runnable candidate spec
//      (it owns the header) and returns it without committing;
//   3. run **that one example** locally against current code;
//   4. green → POST the **same** body to reshape and print the committed message;
//      red → print the Rails-authored business message and commit nothing.
export async function putReshape(config: Config, _args: string[] = [], deps?: Partial<PutReshapeDeps>): Promise<void> {
  const wire = new Wire(config);
  const d: PutReshapeDeps = {
    postReshapeCandidate: (payload) => wire.postReshapeCandidate(payload),
    postReshapeCommit: (payload) => wire.postReshapeCommit(payload),
    runExample: runRspecExample,
    stdout: process.stdout,
    ...deps,
  };

  const request = readReshapeRequest(config.projectRoot);
  const output = readReshapeOutput(request.output_path); // throws on empty body → nothing uploaded

  // The body Rails assembles, runs, and (only on green) commits — identical at
  // both POSTs so the host cannot swap content between the gate and the commit.
  const body = {
    test_id: request.test_id,
    body: output.body,
    headline: output.headline,
    description: output.description,
    suite_digest: request.suite_digest,
  };

  const candidate = await d.postReshapeCandidate(body);
  const specPath = writeCandidateSpec(config.projectRoot, candidate.candidate_spec);
  const result = await d.runExample(config.projectRoot, relative(config.projectRoot, specPath), request.test_id);

  if (!isGreen(result)) {
    d.stdout.write(`${candidate.red_message}\n`);
    return;
  }

  const committed = await d.postReshapeCommit({ ...body, gate: 'green' });
  d.stdout.write(`${committed.message}\n`);
  if (committed.map_url) d.stdout.write(`${committed.map_url}\n`);
}

// Green only when the single example RSpec ran reports it passed. An unparseable
// run, a load error, or any non-passed status is treated as red — the contract
// must not be committed on anything but a clean pass.
function isGreen(result: RspecRunResult): boolean {
  if (result.code !== 0) return false;

  try {
    const parsed = JSON.parse(result.stdout) as { examples?: Array<{ status?: string }> };
    const example = Array.isArray(parsed.examples) ? parsed.examples[0] : undefined;
    return example?.status === 'passed';
  } catch {
    return false;
  }
}
