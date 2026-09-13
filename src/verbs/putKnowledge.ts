import type { Config } from '../config.ts';
import { parseFeatureId, readKnowledge } from '../files/features.ts';
import { enterUrl } from '../links.ts';
import { Wire, type KnowledgeRecorded } from '../wire.ts';

interface PutKnowledgeDeps {
  putKnowledge: (featureId: number, knowledge: string) => Promise<KnowledgeRecorded>;
  stdout: { write: (chunk: string) => unknown };
}

// Send `knowledge.md` as text (spec 52-2, AC 2.2) and print the server's
// sentence and the link to the feature's page through the exchanger, like
// every link a person gets from the terminal (spec 33). The shape is checked
// on the server only (Non-Goals); a 422 comes back through the wire as a
// WireError whose text already holds one line per problem, both sides, and
// this lets it through so the host fixes the file and runs this again.
export async function putKnowledge(config: Config, args: string[] = [], deps?: Partial<PutKnowledgeDeps>): Promise<void> {
  const d: PutKnowledgeDeps = {
    putKnowledge: (id, knowledge) => new Wire(config).putKnowledge(id, knowledge),
    stdout: process.stdout,
    ...deps,
  };

  const featureId = parseFeatureId(args[0], 'put-knowledge');
  const text = readKnowledge(config.projectRoot, featureId);
  const recorded = await d.putKnowledge(featureId, text);
  d.stdout.write(`${recorded.message}\n`);
  d.stdout.write(`${enterUrl(config, recorded.url)}\n`);
}
