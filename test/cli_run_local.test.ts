import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { outputPath, writeSuiteBuildRequest } from '../src/files/suiteBuild.ts';

// Spec 34-6, criterion 3, through the production assembly rather than an
// injected one. `run-local` grew the first non-zero exit that is not an error,
// and the CLI arm that carries it is one line — exactly the shape of wiring that
// `agents/AGENTS.md` ("Injected tests can miss dead production wiring") says to
// cover for real: the nine unit tests around `runLocal` would all still pass if
// `cli.ts` went on returning a hardcoded 0.
//
// The runner is a fake `bin/rspec` inside the project, which is the real path
// `runner/rspec.ts` prefers when the file is executable. It writes the report
// the connector reads back, so nothing here stubs the connector itself.
const FAILED_EXAMPLE = JSON.stringify({
  examples: [{
    description: 'ubc_0123456789ab guards checkout',
    file_path: './a_spec.rb',
    status: 'failed',
    exception: { message: 'expected 200, got 500' },
  }],
});

function stuckProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-cli-run-local-'));
  mkdirSync(join(projectRoot, 'bin'), { recursive: true });
  mkdirSync(join(projectRoot, '.unitbob', 'structural'), { recursive: true });
  writeFileSync(join(projectRoot, 'Gemfile'), 'gem "rspec-rails"\n');
  writeFileSync(
    join(projectRoot, '.unitbob', 'structural', 'architecture_map_contracts_spec.rb'),
    "require_relative 'unitbob_helper'\n",
  );

  // Always the same failure, so the second run is the stuck one.
  const fakeRspec = join(projectRoot, 'bin', 'rspec');
  writeFileSync(
    fakeRspec,
    `#!/bin/sh\nmkdir -p .unitbob/structural\ncat > .unitbob/structural/rspec_result.json <<'REPORT'\n${FAILED_EXAMPLE}\nREPORT\nexit 1\n`,
  );
  chmodSync(fakeRspec, 0o755);

  const manifest = { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' };
  writeSuiteBuildRequest(projectRoot, [{
    suite_kind: 'structural', source_digest: 'map-d', path_root: '.unitbob/structural/',
    recipe: { name: 'generate', version: 'g1', text: 'g' }, assignment: {},
    runner_manifest: manifest,
  }]);
  writeFileSync(outputPath(projectRoot), JSON.stringify({
    branches: [{
      suite_kind: 'structural',
      suite_file: { path: '.unitbob/structural/architecture_map_contracts_spec.rb' },
      runner_manifest: manifest,
      test_metadata: { capabilities: [] },
    }],
  }));
  return projectRoot;
}

test('the CLI exits zero on a red run and non-zero on the second identical one', async () => {
  const projectRoot = stuckProject();
  const linked = { ensureLinked: async () => ({ server: 'https://host', repoId: 3, projectRoot }) };

  // Red tests are the product working, so the first run exits zero even though
  // the runner did not.
  assert.equal(await main(['run-local'], linked), 0);

  // The same failures again: the edits between the two runs changed nothing.
  assert.equal(await main(['run-local'], linked), 1);
});
