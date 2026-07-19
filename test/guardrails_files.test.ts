import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertGuardrailPath,
  materializeGuardrails,
  materializeHelper,
  UNITBOB_HELPER_RB,
  type SuiteBlob,
} from '../src/files/guardrails.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-guardrails-'));
}

function rubySuite(content: string, digest = 'd1'): SuiteBlob {
  return {
    suite_digest: digest,
    suite_file: { path: '.unitbob/guardrails/architecture_map_contracts_spec.rb', content },
    runner_manifest: { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' },
  };
}

test('materializes the verbatim suite at its own path under .unitbob/guardrails', () => {
  const projectRoot = tmpProject();

  materializeGuardrails(projectRoot, rubySuite("require 'rails_helper'\n\nRSpec.describe('x') {}\n"));

  assert.equal(
    readFileSync(join(projectRoot, '.unitbob', 'guardrails', 'architecture_map_contracts_spec.rb'), 'utf8'),
    "require 'rails_helper'\n\nRSpec.describe('x') {}\n",
  );
});

test('materializes a vitest suite without the Ruby boot kit', () => {
  const projectRoot = tmpProject();
  const suite: SuiteBlob = {
    suite_digest: 'd1',
    suite_file: { path: '.unitbob/guardrails/architecture_map_contracts.test.ts', content: 'import { it } from "vitest";\n' },
    runner_manifest: { language: 'javascript', framework: 'vitest', result_format: 'vitest_json', runner: 'vitest' },
  };

  materializeGuardrails(projectRoot, suite);

  const dir = join(projectRoot, '.unitbob', 'guardrails');
  assert.equal(readFileSync(join(dir, 'architecture_map_contracts.test.ts'), 'utf8'), 'import { it } from "vitest";\n');
  assert.equal(existsSync(join(dir, 'unitbob_helper.rb')), false);
  assert.equal(existsSync(join(dir, 'rspec.opts')), false);
});

test('refuses unsafe suite paths and writes nothing', () => {
  const projectRoot = tmpProject();
  const unsafe = [
    '/etc/passwd',
    'spec/pwned_spec.rb',
    '.unitbob/guardrails/../../pwned.rb',
    '',
  ];

  for (const path of unsafe) {
    assert.throws(
      () => materializeGuardrails(projectRoot, { ...rubySuite('x'), suite_file: { path, content: 'x' } }),
      /relative path under/,
      path,
    );
  }
  assert.equal(existsSync(join(projectRoot, 'spec')), false);
  assert.equal(existsSync(join(projectRoot, 'pwned.rb')), false);
});

test('assertGuardrailPath accepts a well-formed guardrail path', () => {
  assertGuardrailPath('.unitbob/guardrails/architecture_map_contracts.test.ts');
});

test('materializes the boot kit (helper + empty rspec options) next to a Ruby suite', () => {
  const projectRoot = tmpProject();
  const dir = join(projectRoot, '.unitbob', 'guardrails');

  materializeGuardrails(projectRoot, rubySuite('suite'));

  assert.equal(readFileSync(join(dir, 'unitbob_helper.rb'), 'utf8'), UNITBOB_HELPER_RB);
  // Empty custom options file — shields guardrail runs from the project's .rspec.
  assert.equal(readFileSync(join(dir, 'rspec.opts'), 'utf8'), '');
});

test('materializeHelper writes the boot kit on its own (suite-build flow)', () => {
  const projectRoot = tmpProject();

  const helperPath = materializeHelper(projectRoot);

  assert.equal(helperPath, join(projectRoot, '.unitbob', 'guardrails', 'unitbob_helper.rb'));
  assert.equal(readFileSync(helperPath, 'utf8'), UNITBOB_HELPER_RB);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'guardrails', 'rspec.opts')), true);
});

// The template is connector-owned Ruby nobody executes in these tests — pin the
// behaviourally load-bearing lines so an accidental edit fails loudly.
test('the helper delegates to the project rails_helper or self-boots the test env', () => {
  assert.match(UNITBOB_HELPER_RB, /File\.exist\?\(File\.join\(root, 'spec', 'rails_helper\.rb'\)\)/);
  assert.match(UNITBOB_HELPER_RB, /require 'rails_helper'/);
  assert.match(UNITBOB_HELPER_RB, /ENV\['RAILS_ENV'\] \|\|= 'test'/);
  // Both refusals: pre-boot on ENV (covers the delegate branch before anything
  // loads) and post-boot on Rails.env (covers config-forced environments).
  assert.match(UNITBOB_HELPER_RB, /abort .+ unless ENV\['RAILS_ENV'\] == 'test'/);
  assert.match(UNITBOB_HELPER_RB, /abort .+ unless Rails\.env\.test\?/);
  assert.match(UNITBOB_HELPER_RB, /maintain_test_schema!/);
  assert.match(UNITBOB_HELPER_RB, /use_transactional_fixtures = true/);
});

// The helper is the sole boot path on every client machine; a syntax error in
// the template must fail here, not on a vibecoder's first run.
test('the helper template is valid Ruby', (t) => {
  const helperPath = materializeHelper(tmpProject());
  let output: string;
  try {
    output = execFileSync('ruby', ['-c', helperPath], { stdio: 'pipe' }).toString();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      t.skip('no ruby on PATH');
      return;
    }
    throw new Error(`ruby -c rejected the helper template: ${String((err as { stderr?: unknown }).stderr ?? err)}`);
  }
  assert.match(output, /Syntax OK/);
});

test('rewrites any existing local guardrail files before each run', () => {
  const projectRoot = tmpProject();
  const dir = join(projectRoot, '.unitbob', 'guardrails');

  materializeGuardrails(projectRoot, rubySuite('old'));
  writeFileSync(join(dir, 'extra.txt'), 'stale');

  materializeGuardrails(projectRoot, rubySuite('new', 'd2'));

  assert.equal(readFileSync(join(dir, 'architecture_map_contracts_spec.rb'), 'utf8'), 'new');
  assert.equal(existsSync(join(dir, 'extra.txt')), false);
});
