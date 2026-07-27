import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { main } from '../src/cli.ts';
import { outputPath, reviewRequestPath, writeSuiteBuildRequest } from '../src/files/suiteBuild.ts';

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

  const previousPath = process.env.PATH;
  process.env.PATH = [fakeBin, previousPath].filter(Boolean).join(delimiter);
  try {
    const exitCode = await main(['suite-review-prepare'], {
      ensureLinked: async () => ({ server: 'https://host', repoId: 3, projectRoot }),
    });
    assert.equal(exitCode, 0);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  const request = JSON.parse(readFileSync(reviewRequestPath(projectRoot), 'utf8'));
  assert.equal(request.candidate_run.revision, 'working-tree');
  assert.equal(request.candidate_run.run_result, '{}\n');
});
