import type { Config } from '../config.ts';
import { Wire, type ContractPrompt } from '../wire.ts';

interface ContractPromptDeps {
  getContractPrompt: (suiteDigest: string, testId: string, intent: string) => Promise<ContractPrompt>;
  stdout: { write: (chunk: string) => unknown };
}

// Fetch the contract action brief for one red check (spec 32). One operation for
// both maps and both intents: the digest names the exact current version (and so
// its contract system), `test_id` is that kind's own id, `intent` is fix|accept.
// The server composes the whole prompt; the connector prints its plain-language
// `message` and the copy-ready `prompt`. A 422 (not current / not failing /
// unknown intent) surfaces via WireError; nothing is fabricated.
export async function contractPrompt(config: Config, args: string[] = [], deps?: Partial<ContractPromptDeps>): Promise<void> {
  const suiteDigest = (args[0] ?? '').trim();
  const testId = (args[1] ?? '').trim();
  const intent = (args[2] ?? 'fix').trim();

  if (!suiteDigest || !testId) {
    throw new Error('Usage: unitbob contract-prompt <suite_digest> <test_id> [fix|accept]');
  }
  if (intent !== 'fix' && intent !== 'accept') {
    throw new Error(`intent must be "fix" or "accept" (got "${intent}").`);
  }

  const d: ContractPromptDeps = {
    getContractPrompt: (digest, id, action) => new Wire(config).getContractPrompt(digest, id, action),
    stdout: process.stdout,
    ...deps,
  };

  const packet = await d.getContractPrompt(suiteDigest, testId, intent);
  d.stdout.write(`${packet.message}\n\n${packet.prompt}\n`);
}
