import type { Config } from '../config.ts';
import { readFeatureAnswer } from '../files/featureStart.ts';
import { enterUrl } from '../links.ts';
import { Wire, type FeatureRecorded, type FeatureUpload } from '../wire.ts';

interface PutFeatureDeps {
  postFeature: (payload: FeatureUpload) => Promise<FeatureRecorded>;
  stdout: { write: (chunk: string) => unknown };
}

// Read the host's answer and record the feature (spec 52-1). The server checks
// every id against the current map and words the sentence; this prints it and
// the link to the feature's page through the exchanger, like every link a
// person gets from the terminal (spec 33). A 422 — an id not on the map — is
// let through as a WireError with both id lists in its text, so the host
// corrects its file and runs this again. Nothing is created locally: the
// feature's folder, its knowledge file and its tests belong to later specs.
export async function putFeature(config: Config, _args: string[] = [], deps?: Partial<PutFeatureDeps>): Promise<void> {
  const d: PutFeatureDeps = {
    postFeature: (payload) => new Wire(config).postFeature(payload),
    stdout: process.stdout,
    ...deps,
  };

  const answer = readFeatureAnswer(config.projectRoot);
  const recorded = await d.postFeature(answer);
  d.stdout.write(`${recorded.message}\n`);
  d.stdout.write(`${enterUrl(config, recorded.url)}\n`);
}
