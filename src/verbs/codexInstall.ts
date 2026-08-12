import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_NAMES = ['suite-worker', 'suite-repair-worker', 'fact-finder', 'suite-reviewer'] as const;
const bundledAgentsDir = fileURLToPath(new URL('../../plugin/codex/agents/', import.meta.url));

interface CodexInstallDeps {
  home: string;
  stdout: { write: (chunk: string) => unknown };
}

export function installCodexAgents(
  args: string[],
  deps: CodexInstallDeps = { home: homedir(), stdout: process.stdout },
): void {
  if (args.length > 0) throw new Error('codex-install accepts no arguments.');

  const targetDir = join(deps.home, '.codex', 'agents');
  const files = AGENT_NAMES.map((name) => ({
    source: join(bundledAgentsDir, `${name}.toml`),
    target: join(targetDir, `${name}.toml`),
  }));

  for (const file of files) {
    if (!existsSync(file.target)) continue;
    if (readFileSync(file.target, 'utf8') === readFileSync(file.source, 'utf8')) continue;
    throw new Error(`Refusing to overwrite existing Codex agent definition: ${file.target}`);
  }

  mkdirSync(targetDir, { recursive: true });
  for (const file of files) {
    if (!existsSync(file.target)) copyFileSync(file.source, file.target);
  }

  deps.stdout.write(
    `Installed 3 Unitbob Codex agent definitions in ${targetDir}. Start a new Codex thread before running Unitbob.\n`,
  );
}
