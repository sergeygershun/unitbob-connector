import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Runtime precheck (spec 26, relaxed in spec 29). The only supported runtime is
// Ruby on Rails with RSpec; no `spec/rails_helper.rb` is required — the connector
// materializes its own boot helper. We confirm the static prerequisites before
// generating or running a suite so an unsupported project stops with one
// actionable message instead of uploading a misleading result. We do not boot the
// app here — an app that cannot boot surfaces later as a suite error from the
// actual RSpec run.
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
  // Specifically rspec-rails: the boot helper requires `rspec/rails`, so a
  // bare `rspec` gem passes nothing downstream — stop with the honest offer.
  if (!hasGemfileWith(projectRoot, /\brspec-rails\b/)) {
    return {
      ok: false,
      message:
        "Unitbob guardrails need the rspec-rails gem, which is not in this project's " +
        'Gemfile. Offer the user to add it and run `bundle install`; change the Gemfile ' +
        'only with their consent, then retry.',
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
