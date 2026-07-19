import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

// The current suite blob the connector materializes and runs (spec 26, made
// language-neutral by spec 30). It is the exact host-written guardrail file —
// `suite_file { path, content }` — plus the suite-level `runner_manifest` and
// the digest. `runner_manifest.runner` is a connector-owned enum naming one
// built-in runner strategy; the connector never executes host-provided command
// strings. `test_metadata` stays server-side and never ships down for a check.
export interface SuiteFile {
  path: string;
  content: string;
}

export interface RunnerManifest {
  runner: string;
  [key: string]: unknown;
}

export interface SuiteBlob {
  suite_digest: string;
  suite_file: SuiteFile;
  runner_manifest: RunnerManifest;
}

// A forward-slash literal, not path.join: suite paths always arrive over the
// wire with '/', while path.join would render this '.unitbob\guardrails' on
// Windows and make assertGuardrailPath reject every valid path there. node's
// path.join still accepts a '/'-joined segment as input on every platform, so
// filesystem builds below are unaffected.
export const GUARDRAILS_DIR = '.unitbob/guardrails';
export const HELPER_FILE = 'unitbob_helper.rb';
// An always-empty custom options file: pointing rspec's --options here keeps
// the project's own .rspec (stray --require lines, extra stdout formatters)
// out of guardrail runs, whose JSON output must stay parseable.
export const OPTIONS_FILE = 'rspec.opts';

// The one place that decides whether a host-provided suite path is safe to
// write: relative, anchored under .unitbob/guardrails/, no traversal. Anything
// else throws and nothing is written.
export function assertGuardrailPath(path: string): void {
  const prefix = `${GUARDRAILS_DIR}/`;
  const unsafe =
    !path || isAbsolute(path) || !path.startsWith(prefix) || path.split('/').some((segment) => segment === '..');
  if (unsafe) {
    throw new Error(`suite_file.path must be a relative path under ${prefix} with no traversal (got "${path}").`);
  }
}

// The boot file the generated Ruby suite requires (spec 29). Connector-owned and
// versioned with it — never scaffolded into the project, never part of the
// suite digest (that covers the suite_file only). Delegates to the project's
// own RSpec setup when one exists; boots the Rails test environment directly
// when none does. Both branches refuse a non-test environment — before boot
// via ENV (nothing touched yet), after boot via Rails.env (config overrides).
export const UNITBOB_HELPER_RB = `# frozen_string_literal: true
# Written by the unitbob connector on every materialization — do not edit.
ENV['RAILS_ENV'] ||= 'test'
abort 'unitbob_helper: refusing to run against a non-test environment' unless ENV['RAILS_ENV'] == 'test'
root = File.expand_path('../..', __dir__)
if File.exist?(File.join(root, 'spec', 'rails_helper.rb'))
  # The project has its own RSpec setup — respect it (factories, cleaners…).
  $LOAD_PATH.unshift File.join(root, 'spec')
  require 'rails_helper'
else
  # No RSpec scaffolding — boot the Rails test environment directly.
  require File.join(root, 'config', 'environment')
  require 'rspec/rails'
  ActiveRecord::Migration.maintain_test_schema!
  RSpec.configure do |config|
    config.use_transactional_fixtures = true
    config.infer_spec_type_from_file_location!
  end
end
abort 'unitbob_helper: refusing to run against a non-test environment' unless Rails.env.test?
`;

// Write the suite blob's guardrail file at its own (validated) relative path.
// The Ruby boot kit is materialized only for the rspec runner — Vitest and
// pytest runs need no connector-written support files here (the runtime
// pytest.ini lives outside this directory and is written by the pytest runner).
export function materializeGuardrails(projectRoot: string, suite: SuiteBlob): { suitePath: string } {
  assertGuardrailPath(suite.suite_file.path);

  const dir = join(projectRoot, GUARDRAILS_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const suitePath = join(projectRoot, suite.suite_file.path);
  mkdirSync(dirname(suitePath), { recursive: true });
  writeFileSync(suitePath, suite.suite_file.content);
  if (suite.runner_manifest.runner === 'rspec') materializeHelper(projectRoot);

  return { suitePath };
}

// Both Ruby flows boot the same way: the check flow writes the boot kit next to
// the suite here, the suite-build flow writes it right after the precheck.
export function materializeHelper(projectRoot: string): string {
  const dir = join(projectRoot, GUARDRAILS_DIR);
  mkdirSync(dir, { recursive: true });

  const helperPath = join(dir, HELPER_FILE);
  writeFileSync(helperPath, UNITBOB_HELPER_RB);
  writeFileSync(join(dir, OPTIONS_FILE), '');
  return helperPath;
}
