import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The current suite blob the connector materializes and runs (spec 26). It is the
// exact host-written file bytes plus their digest — `test_metadata` stays
// server-side and never ships down for a check.
export interface SuiteBlob {
  suite_digest: string;
  spec_rb: string;
}

export const GUARDRAILS_DIR = join('.unitbob', 'guardrails');
export const SUITE_FILE = 'architecture_map_contracts_spec.rb';
export const HELPER_FILE = 'unitbob_helper.rb';
// An always-empty custom options file: pointing rspec's --options here keeps
// the project's own .rspec (stray --require lines, extra stdout formatters)
// out of guardrail runs, whose JSON output must stay parseable.
export const OPTIONS_FILE = 'rspec.opts';

// The boot file the generated suite requires (spec 29). Connector-owned and
// versioned with it — never scaffolded into the project, never part of the
// suite digest (that covers `spec_rb` bytes only). Delegates to the project's
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

export function materializeGuardrails(projectRoot: string, suite: SuiteBlob): { suitePath: string } {
  const dir = join(projectRoot, GUARDRAILS_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const suitePath = join(dir, SUITE_FILE);
  writeFileSync(suitePath, suite.spec_rb);
  materializeHelper(projectRoot);

  return { suitePath };
}

// Both flows boot the same way: the check flow writes the boot kit next to
// the suite here, the suite-build flow writes it right after the precheck.
export function materializeHelper(projectRoot: string): string {
  const dir = join(projectRoot, GUARDRAILS_DIR);
  mkdirSync(dir, { recursive: true });

  const helperPath = join(dir, HELPER_FILE);
  writeFileSync(helperPath, UNITBOB_HELPER_RB);
  writeFileSync(join(dir, OPTIONS_FILE), '');
  return helperPath;
}
