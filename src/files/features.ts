import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { KnowledgePacket, Recipe } from '../wire.ts';

// A feature's folder on disk (spec 52-2): `.unitbob/features/<id>/`. This is
// the first spec that gives a feature a folder; the talk's request and the
// file it folds into live here, and spec 52-3 puts its own request beside them.
export function featureDir(projectRoot: string, featureId: number | string): string {
  return join(projectRoot, '.unitbob', 'features', String(featureId));
}

// The id as the list printed it and the folder is named: a number. A word
// ("refunds") is the person's, not the server's, and the verb says so.
export function parseFeatureId(raw: string | undefined, verb: string): number {
  if (raw === undefined) throw new Error(`Usage: unitbob ${verb} <feature_id>`);
  if (!/^\d+$/.test(raw)) throw new Error(`unitbob ${verb}: the feature id must be a number, got "${raw}".`);
  return Number(raw);
}

export function knowledgeRequestPath(projectRoot: string, featureId: number | string): string {
  return join(featureDir(projectRoot, featureId), 'request.json');
}

export function knowledgePath(projectRoot: string, featureId: number | string): string {
  return join(featureDir(projectRoot, featureId), 'knowledge.md');
}

// The task the host reads to talk the feature through: the recipe, the packet
// the server built (the feature, each affected promise with its state in the
// server's words, an earlier knowledge text if the talk was held before), the
// two local folders the host may read for facts — each only when it is on
// disk — and where `knowledge.md` goes.
export interface KnowledgeRequest {
  project_root: string;
  recipe: Recipe;
  feature: KnowledgePacket['feature'];
  affected: KnowledgePacket['affected'];
  knowledge: string | null;
  behavioral_suite_path: string | null;
  map_documents_path: string | null;
  output_path: string;
}

export function writeKnowledgeRequest(
  projectRoot: string,
  featureId: number | string,
  recipe: Recipe,
  packet: KnowledgePacket,
): KnowledgeRequest {
  const request: KnowledgeRequest = {
    project_root: projectRoot,
    recipe,
    feature: packet.feature,
    affected: packet.affected,
    knowledge: packet.knowledge,
    behavioral_suite_path: presentDir(join(projectRoot, '.unitbob', 'behavioral')),
    map_documents_path: presentDir(join(projectRoot, '.unitbob', 'map-build')),
    output_path: knowledgePath(projectRoot, featureId),
  };

  const path = knowledgeRequestPath(projectRoot, featureId);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(request, null, 2)}\n`);
  return request;
}

// The file as text, and nothing else: the server is the one place that checks
// its shape (spec 52-2, Non-Goals), so the connector only refuses to send
// nothing.
export function readKnowledge(projectRoot: string, featureId: number | string): string {
  const path = knowledgePath(projectRoot, featureId);
  if (!existsSync(path)) {
    throw new Error(`No knowledge file at ${path}. Write it as the recipe describes, then run \`unitbob put-knowledge\`.`);
  }
  const text = readFileSync(path, 'utf8');
  if (text.trim() === '') throw new Error(`${path} is empty. Write it as the recipe describes, then run \`unitbob put-knowledge\`.`);
  return text;
}

function presentDir(path: string): string | null {
  return existsSync(path) ? path : null;
}
