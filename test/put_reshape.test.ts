import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { putReshape } from '../src/verbs/putReshape.ts';
import { outputPath, writeReshapeRequest } from '../src/files/reshape.ts';
import type { Config } from '../src/config.ts';
import type { ReshapeCandidateResult, ReshapeCommitResult } from '../src/wire.ts';
import type { RspecRunResult as RunnerResult } from '../src/runner/rspec.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-put-reshape-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

function seedTask(projectRoot: string, suiteDigest = 'sha256-suite'): void {
  writeReshapeRequest(projectRoot, 'guard-1', {
    recipe: { name: 'generate', version: 'g1', text: 'g' },
    packet: { block: { id: 'block:billing' } },
    suite_digest: suiteDigest,
  });
}

function rspec(status: string): RunnerResult {
  return { stdout: JSON.stringify({ examples: [{ status }] }), stderr: '', code: 0, command: 'rspec', args: [] };
}

function failedRspecWithPassedExample(): RunnerResult {
  return { stdout: JSON.stringify({ examples: [{ status: 'passed' }] }), stderr: 'after suite failed', code: 1, command: 'rspec', args: [] };
}

const candidate: ReshapeCandidateResult = {
  candidate_spec: 'RSpec.describe("x") {}',
  red_message: "Couldn't update the guard for «billing» — the code doesn't pass it yet.",
};

test('put-reshape runs the candidate and commits the same body on green (M1)', async () => {
  const projectRoot = tmpProject();
  seedTask(projectRoot);
  writeFileSync(outputPath(projectRoot), JSON.stringify({ headline: 'H', description: 'D', body: 'expect(1).to eq 1' }));

  const out: string[] = [];
  let candidatePayload: unknown = null;
  let commitPayload: unknown = null;
  const commit: ReshapeCommitResult = {
    suite_version_id: 12,
    suite_digest: 'sha256-new',
    map_url: 'http://host/repos/3/map',
    message: 'Updated the guard for «billing».',
  };

  await putReshape(config(projectRoot), [], {
    postReshapeCandidate: async (p) => {
      candidatePayload = p;
      return candidate;
    },
    postReshapeCommit: async (p) => {
      commitPayload = p;
      return commit;
    },
    runExample: async () => rspec('passed'),
    stdout: { write: (chunk) => out.push(String(chunk)) },
  });

  // M1: the body sent to commit is the very body that was assembled and run.
  assert.deepEqual(candidatePayload, {
    test_id: 'guard-1',
    body: 'expect(1).to eq 1',
    headline: 'H',
    description: 'D',
    suite_digest: 'sha256-suite',
  });
  assert.deepEqual(commitPayload, { ...(candidatePayload as object), gate: 'green' });
  assert.ok(out.join('').includes('Updated the guard'));
  assert.ok(out.join('').includes('http://host/repos/3/map'));
});

test('put-reshape commits nothing on a red gate and prints the Rails message', async () => {
  const projectRoot = tmpProject();
  seedTask(projectRoot);
  writeFileSync(outputPath(projectRoot), JSON.stringify({ body: 'expect(1).to eq 2' }));

  const out: string[] = [];
  let committed = false;

  await putReshape(config(projectRoot), [], {
    postReshapeCandidate: async () => candidate,
    postReshapeCommit: async () => {
      committed = true;
      throw new Error('should not commit on red');
    },
    runExample: async () => rspec('failed'),
    stdout: { write: (chunk) => out.push(String(chunk)) },
  });

  assert.equal(committed, false);
  assert.ok(out.join('').includes("doesn't pass it yet"));
});

test('put-reshape commits nothing when RSpec exits non-zero even if the example says passed', async () => {
  const projectRoot = tmpProject();
  seedTask(projectRoot);
  writeFileSync(outputPath(projectRoot), JSON.stringify({ body: 'expect(1).to eq 1' }));

  let committed = false;

  await putReshape(config(projectRoot), [], {
    postReshapeCandidate: async () => candidate,
    postReshapeCommit: async () => {
      committed = true;
      throw new Error('should not commit on a non-zero gate');
    },
    runExample: async () => failedRspecWithPassedExample(),
    stdout: { write: () => true },
  });

  assert.equal(committed, false);
});

test('put-reshape uploads nothing when the host body is empty (M2)', async () => {
  const projectRoot = tmpProject();
  seedTask(projectRoot);
  writeFileSync(outputPath(projectRoot), JSON.stringify({ body: '   ' }));

  let uploaded = false;
  await assert.rejects(
    () =>
      putReshape(config(projectRoot), [], {
        postReshapeCandidate: async () => {
          uploaded = true;
          return candidate;
        },
        postReshapeCommit: async () => candidate as unknown as ReshapeCommitResult,
        runExample: async () => rspec('passed'),
      }),
    /non-empty "body"/,
  );
  assert.equal(uploaded, false);
});
