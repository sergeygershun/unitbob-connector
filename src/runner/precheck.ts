import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Runtime precheck (spec 26). The only supported runtime is Ruby on Rails with
// RSpec and a loadable `spec/rails_helper.rb`. We confirm the static prerequisites
// before generating or running a suite so an unsupported project stops with one
// actionable message instead of uploading a misleading result. We do not boot the
// app here — a `rails_helper` that exists but cannot load surfaces later as a
// suite error from the actual RSpec run.
export interface PrecheckResult {
  ok: boolean;
  message?: string;
}

const SUPPORTED =
  'Unitbob guardrails support Ruby on Rails projects using RSpec only. ' +
  'This project does not look like Rails + RSpec.';

export function runtimePrecheck(projectRoot: string): PrecheckResult {
  if (!hasGemfileWith(projectRoot, /\brails\b/)) {
    return { ok: false, message: `${SUPPORTED} (no \`rails\` gem found in Gemfile.)` };
  }
  if (!hasGemfileWith(projectRoot, /\brspec(-rails)?\b/)) {
    return { ok: false, message: `${SUPPORTED} (no \`rspec\`/\`rspec-rails\` gem found in Gemfile.)` };
  }
  if (!existsSync(join(projectRoot, 'spec', 'rails_helper.rb'))) {
    return {
      ok: false,
      message:
        'Unitbob needs spec/rails_helper.rb to run Rails guardrails, but it was not found. ' +
        'Set up RSpec for this Rails project first, then try again.',
    };
  }
  return { ok: true };
}

function hasGemfileWith(projectRoot: string, pattern: RegExp): boolean {
  for (const name of ['Gemfile', 'gems.rb']) {
    const path = join(projectRoot, name);
    if (existsSync(path) && pattern.test(readFileSync(path, 'utf8'))) return true;
  }
  return false;
}
