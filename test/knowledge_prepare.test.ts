import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgePrepare } from '../src/verbs/knowledgePrepare.ts';
import { knowledgeRequestPath } from '../src/files/features.ts';
import type { Config } from '../src/config.ts';
import type { FeatureListItem, KnowledgePacket, Recipe } from '../src/wire.ts';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-knowledge-prepare-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, token: 't', projectRoot };
}

const recipe: Recipe = { name: 'feature_grill', version: 'r1', text: 'Talk the feature through.' };
const emptyText = 'No feature to talk through yet — say what you want to build first.';

function listOf(features: FeatureListItem[]) {
  return async () => ({ features, empty_text: emptyText });
}

const packet: KnowledgePacket = {
  feature: { feature_id: 12, title: 'Refunds', intent: 'refunds for paid orders', status: 'intent', created_at: 'x' },
  affected: [{ id: 'billing', title: 'Billing', why: 'Money.', headline: 'The shopper can pay', status: 'passed', gone: false }],
  knowledge: null,
};

// Without an id the verb is a lookup: the host finds the feature by the
// person's words in the list, and only features still to be talked through
// (or talked through and open to a second talk) are listed.
test('knowledge-prepare without an argument lists the features that can be talked through', async () => {
  const projectRoot = tmpProject();
  const out: string[] = [];

  await knowledgePrepare(config(projectRoot), [], {
    listFeatures: listOf([
      { feature_id: 12, title: 'Refunds', status: 'intent', created_at: 'x' },
      { feature_id: 11, title: 'Comments', status: 'knowledge', created_at: 'x' },
      { feature_id: 10, title: 'Old one', status: 'done', created_at: 'x' },
    ]),
    stdout: { write: (chunk) => out.push(String(chunk)) },
  });

  assert.equal(out.join(''), '12  Refunds (intent)\n11  Comments (knowledge)\n');
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'features')), false);
});

test('knowledge-prepare prints the server’s words when there is nothing to talk through', async () => {
  const out: string[] = [];

  await knowledgePrepare(config(tmpProject()), [], {
    listFeatures: listOf([{ feature_id: 10, title: 'Old one', status: 'done', created_at: 'x' }]),
    stdout: { write: (chunk) => out.push(String(chunk)) },
  });

  assert.equal(out.join(''), `${emptyText}\n`);
});

test('knowledge-prepare <id> fetches the recipe and the packet, writes the request and says where', async () => {
  const projectRoot = tmpProject();
  const out: string[] = [];
  const asked: string[] = [];

  await knowledgePrepare(config(projectRoot), ['12'], {
    getRecipe: async (name) => {
      asked.push(name);
      return recipe;
    },
    getKnowledgePacket: async (id) => {
      asked.push(`packet:${id}`);
      return packet;
    },
    stdout: { write: (chunk) => out.push(String(chunk)) },
  });

  assert.deepEqual(asked.sort(), ['feature_grill', 'packet:12']);
  const written = JSON.parse(readFileSync(knowledgeRequestPath(projectRoot, 12), 'utf8'));
  assert.deepEqual(written.recipe, recipe);
  assert.deepEqual(written.feature, packet.feature);
  assert.deepEqual(written.affected, packet.affected);
  assert.equal(written.output_path, join(projectRoot, '.unitbob', 'features', '12', 'knowledge.md'));
  assert.equal(out.join(''), `Knowledge request written to ${knowledgeRequestPath(projectRoot, 12)}\n`);
});

test('knowledge-prepare refuses an id that is not a number', async () => {
  await assert.rejects(() => knowledgePrepare(config(tmpProject()), ['refunds']), /feature id must be a number/);
});
