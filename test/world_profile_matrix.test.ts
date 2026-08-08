import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeBehavioralWorld } from '../src/files/behavioral.ts';
import { ensureRunner } from '../src/runner/provision.ts';
import { probeBehavioralWorld } from '../src/runner/worldProbe.ts';
import { runProcess } from '../src/proc.ts';

const selected = process.env.UNITBOB_WORLD_PROFILE;
const profiles = ['rails_5', 'rails_7'] as const;
const fixtures = fileURLToPath(new URL('./fixtures/world_profiles', import.meta.url));

for (const profile of profiles.filter((candidate) => !selected || candidate === selected)) {
  test(`World probe is green on ${profile}`, { skip: !selected }, async () => {
    const root = mkdtempSync(join(tmpdir(), `unitbob-${profile}-`));
    cpSync(join(fixtures, profile), root, { recursive: true });
    process.env.UNITBOB_PROFILE_DB = join(root, 'test.sqlite3');
    const bundle = process.env.UNITBOB_PROFILE_BUNDLE ?? 'bundle';
    const ruby = process.env.UNITBOB_PROFILE_RUBY;
    const runCmd = (command: string, args: string[], options: { cwd: string; env?: Record<string, string> }) =>
      runProcess(command === 'bundle' && ruby ? ruby : (command === 'bundle' ? bundle : command),
        command === 'bundle' && ruby ? [bundle, ...args] : args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeoutMs: 120_000,
      });

    const provision = await ensureRunner(root, 'cucumber', { runCmd });
    assert.equal(provision.status, 'provisioned', provision.message);
    materializeBehavioralWorld(root);
    const probe = await probeBehavioralWorld(root, { runCmd });
    assert.equal(probe.status, 'ok', probe.message);
  });
}
