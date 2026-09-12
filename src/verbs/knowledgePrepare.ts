import type { Config } from '../config.ts';
import { knowledgeRequestPath, writeKnowledgeRequest } from '../files/features.ts';
import { Wire, type FeatureListItem, type KnowledgePacket, type Recipe } from '../wire.ts';

interface KnowledgePrepareDeps {
  listFeatures: () => Promise<{ features: FeatureListItem[]; empty_text: string }>;
  getRecipe: (name: string) => Promise<Recipe>;
  getKnowledgePacket: (featureId: number) => Promise<KnowledgePacket>;
  stdout: { write: (chunk: string) => unknown };
}

// The statuses a feature can be talked through in: not yet talked through,
// or talked through and open to a second talk (spec 52-2, AC 2.1).
const TALKABLE = new Set(['intent', 'knowledge']);

// Two forms (spec 52-2, AC 2.1). Without an id, the list: one line per feature
// the talk can start on, so the host finds the one the person means by its
// words — and the server's own sentence when there is none; the connector
// words no state of its own. With an id, the host's task: the recipe and the
// packet the server built, written to `.unitbob/features/<id>/request.json`
// next to where `knowledge.md` will go. No model is called, nothing is
// uploaded.
export async function knowledgePrepare(
  config: Config,
  args: string[] = [],
  deps?: Partial<KnowledgePrepareDeps>,
): Promise<void> {
  const wire = new Wire(config);
  const d: KnowledgePrepareDeps = {
    listFeatures: () => wire.listFeatures(),
    getRecipe: (name) => wire.getRecipe(name),
    getKnowledgePacket: (id) => wire.getKnowledgePacket(id),
    stdout: process.stdout,
    ...deps,
  };

  if (args.length === 0) {
    const list = await d.listFeatures();
    const talkable = list.features.filter((feature) => TALKABLE.has(feature.status));
    if (talkable.length === 0) {
      d.stdout.write(`${list.empty_text}\n`);
      return;
    }
    for (const feature of talkable) {
      d.stdout.write(`${feature.feature_id}  ${feature.title} (${feature.status})\n`);
    }
    return;
  }

  const featureId = parseFeatureId(args[0], 'knowledge-prepare');
  const [recipe, packet] = await Promise.all([d.getRecipe('feature_grill'), d.getKnowledgePacket(featureId)]);
  writeKnowledgeRequest(config.projectRoot, featureId, recipe, packet);
  d.stdout.write(`Knowledge request written to ${knowledgeRequestPath(config.projectRoot, featureId)}\n`);
}

export function parseFeatureId(raw: string | undefined, verb: string): number {
  if (raw === undefined) throw new Error(`Usage: unitbob ${verb} <feature_id>`);
  if (!/^\d+$/.test(raw)) throw new Error(`unitbob ${verb}: the feature id must be a number, got "${raw}".`);
  return Number(raw);
}
