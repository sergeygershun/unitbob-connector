import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { featurePrepare } from '../src/verbs/featurePrepare.ts';
import { requestPath } from '../src/files/featureStart.ts';
import type { Config } from '../src/config.ts';
import { WireError, type Recipe, type SuitePacket } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-feature-prepare-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, token: 't', projectRoot };
}

const recipe: Recipe = { name: 'feature_intent', version: 'r1', text: 'Name what this change may touch.' };

const capability = {
  capability_id: 'posts',
  title: 'Posts',
  description: 'People write and read posts.',
  surfaces: ['GET /posts'],
  tables: ['posts'],
  externals: [],
  contract_key: 'contract:posts',
  case_marker: 'ub_posts',
};

function packets(): SuitePacket[] {
  return [
    { suite_kind: 'structural', source_digest: 'm', path_root: '.unitbob/structural/', assignment: { blocks: [] } },
    {
      suite_kind: 'behavioral',
      source_digest: 's',
      path_root: '.unitbob/behavioral/',
      assignment: { surface_budget: 20, capabilities: [capability] },
    },
  ];
}

test('feature-prepare takes the behavioral packet, writes the request and says where', async () => {
  const projectRoot = tmpProject();
  const out: string[] = [];
  const recipesAsked: string[] = [];

  await featurePrepare(config(projectRoot), [], {
    getRecipe: async (name) => {
      recipesAsked.push(name);
      return recipe;
    },
    getSuitePacketsBatch: async () => packets(),
    stdout: { write: (chunk) => out.push(String(chunk)) },
  });

  assert.deepEqual(recipesAsked, ['feature_intent']);
  const written = JSON.parse(readFileSync(requestPath(projectRoot), 'utf8'));
  assert.deepEqual(written.recipe, recipe);
  // The six fields the recipe names, and not the contract identity — the host
  // is naming what may be touched, not writing tests.
  assert.deepEqual(written.capabilities, [
    {
      capability_id: 'posts',
      title: 'Posts',
      description: 'People write and read posts.',
      surfaces: ['GET /posts'],
      tables: ['posts'],
      externals: [],
    },
  ]);
  assert.equal(written.output_path, join(projectRoot, '.unitbob', 'feature-start', 'feature.json'));
  assert.ok(out.join('').includes(`Feature request written to ${requestPath(projectRoot)}`));
});

// The server's 409 (no current map) is the whole answer: its text tells the
// person to build the map first, and nothing is written.
test('feature-prepare writes nothing when there is no current map', async () => {
  const projectRoot = tmpProject();

  await assert.rejects(
    () =>
      featurePrepare(config(projectRoot), [], {
        getRecipe: async () => recipe,
        getSuitePacketsBatch: async () => {
          throw new WireError('GET /repos/3/suite_packets failed: 409 — No current map — rebuild first.');
        },
      }),
    /No current map/,
  );
  assert.ok(!existsSync(requestPath(projectRoot)));
});

test('feature-prepare refuses a batch without a behavioral packet', async () => {
  const projectRoot = tmpProject();

  await assert.rejects(
    () =>
      featurePrepare(config(projectRoot), [], {
        getRecipe: async () => recipe,
        getSuitePacketsBatch: async () => packets().filter((packet) => packet.suite_kind === 'structural'),
      }),
    /behavioral/,
  );
  assert.ok(!existsSync(requestPath(projectRoot)));
});
