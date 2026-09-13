import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { materializeBehavioralUnion } from '../src/files/behavioral.ts';
import type { Config } from '../src/config.ts';

// Spec 52-4, AC 1.8, through the production assembly. `FeatureFilesChangedError`
// is thrown two modules below the CLI and the sentence is meant for the
// terminal; the one `catch` in `cli.ts` is what carries it there with exit
// code 1, for every verb that materialises the union. An injected `run` test
// proves the throw; this proves the wiring above it.
const FEATURE = {
  feature_id: 12,
  title: 'Refunds for paid orders',
  feature_tag: 'unitbob_feature_12',
  suite_digest: 'f12',
  suite_file: {
    path: '.unitbob/behavioral/features/feature_12.feature',
    content: 'Feature: Refunds\n',
    support_files: [{ path: '.unitbob/behavioral/step_definitions/feature_12_steps.rb', content: '# saved\n' }],
  },
  runner_manifest: { runner: 'cucumber', result_format: 'cucumber_messages' },
};

const MAIN = {
  suite_kind: 'behavioral',
  status: 'ready',
  suite_digest: 'm',
  suite_file: { path: '.unitbob/behavioral/features/surface_contracts.feature', content: 'Feature: x\n' },
  runner_manifest: { runner: 'cucumber', result_format: 'cucumber_messages' },
};

test('check prints the AC 1.8 sentence and exits 1 when a feature file changed on disk, posting nothing', async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ suites: [{ suite_kind: 'structural', status: 'not_built' }, MAIN], feature_suites: [FEATURE] }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-cli-changed-'));
  const config: Config = { server: `http://127.0.0.1:${port}`, repoId: 3, token: 't', projectRoot };
  // A Rails project, so the behavioral branch passes its stack check and
  // reaches the union — the check runs before anything touches the disk.
  writeFileSync(join(projectRoot, 'Gemfile'), 'gem "rails"\n');
  materializeBehavioralUnion(projectRoot, { suites: [MAIN], feature_suites: [FEATURE] }, 'cucumber');
  const rewired = join(projectRoot, FEATURE.suite_file.support_files[0].path);
  writeFileSync(rewired, '# rewired\n');

  let stderr = '';
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
  let code: number;
  try {
    code = await main(['check'], { ensureLinked: async () => config });
  } finally {
    process.stderr.write = original;
    server.close();
  }

  assert.equal(code, 1);
  assert.equal(
    stderr,
    'The checks for “Refunds for paid orders” changed on disk since they were saved. Run `npx unitbob put-tests 12` to save them, then try again.\n',
  );
  assert.deepEqual(hits, ['GET /repos/3/suites']);
  assert.equal(readFileSync(rewired, 'utf8'), '# rewired\n');
});
