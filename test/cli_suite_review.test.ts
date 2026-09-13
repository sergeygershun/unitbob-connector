import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { main } from '../src/cli.ts';
import { candidateRunPath, outputPath, reviewRequestPath, writeSuiteBuildRequest } from '../src/files/suiteBuild.ts';

test('the CLI production assembly runs and binds the behavioral review candidate', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-cli-review-'));
  const fakeBin = join(projectRoot, 'fake-bin');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral'), { recursive: true });
  writeFileSync(join(projectRoot, 'Gemfile'), 'gem "rails"\n');
  writeFileSync(join(projectRoot, '.unitbob', 'behavioral', 'Gemfile'), 'gem "cucumber"\n');

  const fakeBundle = join(fakeBin, 'bundle');
  writeFileSync(
    fakeBundle,
    '#!/bin/sh\nmkdir -p .unitbob/behavioral\nprintf \'{}\\n\' > "$9"\nexit 1\n',
  );
  chmodSync(fakeBundle, 0o755);

  writeSuiteBuildRequest(projectRoot, [{
    suite_kind: 'behavioral', source_digest: 'surface-d', path_root: '.unitbob/behavioral/',
    recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' }, assignment: {},
  }], { status: 'not_supplied' });
  const behavioral = {
    suite_kind: 'behavioral',
    suite_file: {
      path: '.unitbob/behavioral/features/surface_contracts.feature',
      content: 'Feature: Product behavior\n',
      support_files: [{ path: '.unitbob/behavioral/step_definitions/steps.rb', content: '# steps\n' }],
    },
    runner_manifest: {
      language: 'ruby', framework: 'cucumber', result_format: 'cucumber_messages',
      runner: 'cucumber', package_manager: 'bundler', runner_version: '9.2.0',
    },
    test_metadata: { capabilities: [] },
  };
  writeFileSync(outputPath(projectRoot), JSON.stringify({ branches: [behavioral] }));

  // The candidate goes on disk as the union with every red feature's checks
  // (spec 52-4, AC 1.8), which the server lists; here there are none.
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ suites: [], feature_suites: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  const previousPath = process.env.PATH;
  process.env.PATH = [fakeBin, previousPath].filter(Boolean).join(delimiter);
  try {
    const exitCode = await main(['suite-review-prepare'], {
      ensureLinked: async () => ({ server: `http://127.0.0.1:${port}`, repoId: 3, token: 't', projectRoot }),
    });
    assert.equal(exitCode, 0);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    server.close();
  }

  // With no known defect there is nothing for the reviewer to read a run for, so
  // the raw report stays in the connector's own file and out of the request.
  const request = JSON.parse(readFileSync(reviewRequestPath(projectRoot), 'utf8'));
  assert.equal(request.candidate_run, undefined);
  assert.equal(request.fixed_candidate_run, undefined);

  const evidence = JSON.parse(readFileSync(candidateRunPath(projectRoot), 'utf8'));
  assert.equal(evidence.candidate_run.revision, 'working-tree');
  assert.equal(evidence.candidate_run.run_result, '{}\n');
});
