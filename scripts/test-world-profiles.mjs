#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const profiles = [
  { name: 'rails_5', rubyVersion: '2.7.8', rubyEnv: 'UNITBOB_RAILS5_RUBY', bundleEnv: 'UNITBOB_RAILS5_BUNDLE' },
  { name: 'rails_7', rubyVersion: '3.3.11', rubyEnv: 'UNITBOB_RAILS7_RUBY', bundleEnv: 'UNITBOB_RAILS7_BUNDLE' },
];

for (const profile of profiles) {
  const ruby = process.env[profile.rubyEnv] ?? rbenvBinary(profile.rubyVersion, 'ruby');
  const bundle = process.env[profile.bundleEnv] ?? rbenvBinary(profile.rubyVersion, 'bundle');
  const result = spawnSync(process.execPath, ['--test', 'test/world_profile_matrix.test.ts'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
    env: {
      ...process.env,
      UNITBOB_WORLD_PROFILE: profile.name,
      UNITBOB_PROFILE_RUBY: ruby,
      UNITBOB_PROFILE_BUNDLE: bundle,
    },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function rbenvBinary(version, name) {
  try {
    const prefix = execFileSync('rbenv', ['prefix', version], { encoding: 'utf8' }).trim();
    return join(prefix, 'bin', name);
  } catch {
    throw new Error(`Set UNITBOB_RAILS${version.startsWith('2.') ? '5' : '7'}_RUBY and its _BUNDLE companion to run the required World profile.`);
  }
}
