import type { Config } from '../config.ts';
import { Wire, type ContractPrompt, type SuiteIndex } from '../wire.ts';

interface ContractPromptDeps {
  getContractPrompt: (suiteDigest: string, testId: string, intent: string) => Promise<ContractPrompt>;
  getSuiteIndex: () => Promise<SuiteIndex>;
  stdout: { write: (chunk: string) => unknown };
}

// Fetch the contract action brief for one red check (spec 32). One operation for
// both maps and both intents: the digest names the exact current version (and so
// its contract system), `test_id` is that kind's own id, `intent` is fix|accept.
// The server composes the whole prompt; the connector prints its plain-language
// `message` and the copy-ready `prompt`. A 422 (not current / not failing /
// unknown intent) surfaces via WireError; nothing is fabricated.
//
// `feature:<id>` stands in for the digest (spec 52-4, AC 1.3): a feature's
// checks are not on the map to copy one from, so the id is resolved to
// the digest of the feature's current checks through the same index `check`
// runs from. The server words the brief itself, and answers 422 to `accept` —
// a feature's scenarios change through the talk, not through an accept.
export async function contractPrompt(config: Config, args: string[] = [], deps?: Partial<ContractPromptDeps>): Promise<void> {
  const selector = (args[0] ?? '').trim();
  const testId = (args[1] ?? '').trim();
  const intent = (args[2] ?? 'fix').trim();

  if (!selector || !testId) {
    throw new Error('Usage: unitbob contract-prompt <suite_digest>|feature:<id> <test_id> [fix|accept]');
  }
  if (intent !== 'fix' && intent !== 'accept') {
    throw new Error(`intent must be "fix" or "accept" (got "${intent}").`);
  }

  const wire = new Wire(config);
  const d: ContractPromptDeps = {
    getContractPrompt: (digest, id, action) => wire.getContractPrompt(digest, id, action),
    getSuiteIndex: () => wire.getSuiteIndex(),
    stdout: process.stdout,
    ...deps,
  };

  const suiteDigest = selector.startsWith(FEATURE_SELECTOR) ? await featureDigest(d, selector.slice(FEATURE_SELECTOR.length)) : selector;
  const packet = await d.getContractPrompt(suiteDigest, testId, intent);
  d.stdout.write(`${packet.message}\n\n${packet.prompt}\n`);
}

const FEATURE_SELECTOR = 'feature:';

// The digest of the feature's current checks. Only a feature being built has
// them in the index: before the checks are written there is nothing to act on,
// and after Finish they are part of the main suite, on the map like the rest.
async function featureDigest(d: ContractPromptDeps, id: string): Promise<string> {
  const item = (await d.getSuiteIndex()).feature_suites.find((entry) => String(entry.feature_id) === id);
  if (!item) throw new Error(`No feature ${id} has checks to act on — it is not being built, or it is finished.`);
  return item.suite_digest;
}
