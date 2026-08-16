import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The four named roles, in one place. Everything that counts them counts this
// list — see the message at the bottom, which used to carry the number as a
// literal and spent a release saying "Installed 3" beside four names.
export const AGENT_NAMES = ['suite-worker', 'suite-repair-worker', 'fact-finder', 'suite-reviewer'] as const;
const bundledAgentsDir = fileURLToPath(new URL('../../plugin/codex/agents/', import.meta.url));

interface CodexInstallDeps {
  home: string;
  stdout: { write: (chunk: string) => unknown };
}

type Outcome = 'created' | 'updated' | 'current';

const LABEL: Record<Outcome, string> = {
  created: 'created:        ',
  updated: 'updated:        ',
  current: 'already current:',
};

// Install (or refresh) the bounded Codex role definitions in the user's agent
// directory.
//
// This used to refuse when an installed file differed from the bundled one, to
// protect a definition the user had edited by hand. The case it actually met was
// the ordinary one: an upgrade from an older release, where every file differs
// and every install therefore failed. Spec 44, §1.6.
//
// The refusal became actively harmful once the workflows started asking a role
// whether this session can see it. A stale role answers that question exactly
// like a current one, so an update nobody could apply reads as "fully equipped"
// — the check would pass and the run would proceed on last release's
// instructions. So the file is overwritten, and what changed is said out loud
// rather than left for the user to discover.
export function installCodexAgents(
  args: string[],
  deps: CodexInstallDeps = { home: homedir(), stdout: process.stdout },
): void {
  if (args.length > 0) throw new Error('codex-install accepts no arguments.');

  const targetDir = join(deps.home, '.codex', 'agents');
  mkdirSync(targetDir, { recursive: true });

  const byOutcome: Record<Outcome, string[]> = { created: [], updated: [], current: [] };
  for (const name of AGENT_NAMES) {
    const source = join(bundledAgentsDir, `${name}.toml`);
    const target = join(targetDir, `${name}.toml`);
    const outcome = outcomeFor(source, target);
    if (outcome !== 'current') copyFileSync(source, target);
    byOutcome[outcome].push(`${name}.toml`);
  }

  const changes = (['created', 'updated', 'current'] as const)
    .filter((outcome) => byOutcome[outcome].length > 0)
    .map((outcome) => `  ${LABEL[outcome]} ${byOutcome[outcome].join(', ')}`);

  // The reason is attached only when something actually changed, and it is
  // worded to be true of both ways it can change. "A thread open before these
  // files existed" is true of a first install and false of an upgrade, where the
  // files did exist — and the upgrade is the case that matters most, because a
  // thread holding last release's definition answers a readiness check exactly
  // like a current one.
  const changed = byOutcome.created.length + byOutcome.updated.length > 0;
  const why = changed
    ? ' — a thread already open is running the definitions it read when it started, not these'
    : '';

  deps.stdout.write(
    `${AGENT_NAMES.length} Unitbob Codex agent definitions in ${targetDir}:\n${changes.join('\n')}\n` +
      `Start a new Codex thread before running Unitbob${why}.\n`,
  );
}

function outcomeFor(source: string, target: string): Outcome {
  if (!existsSync(target)) return 'created';
  return readFileSync(target, 'utf8') === readFileSync(source, 'utf8') ? 'current' : 'updated';
}
