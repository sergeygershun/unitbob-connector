// `unitbob init` — write a `.unitbob.json` template at the current directory and
// make sure it is git-ignored. This is the one verb that does not require an
// existing config, since its job is to create one.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_FILE = '.unitbob.json';
const ARTIFACT_DIR = '.unitbob/';
const GITIGNORE = '.gitignore';

export async function init(_args: string[]): Promise<void> {
  const cwd = process.cwd();
  const configPath = join(cwd, CONFIG_FILE);

  if (existsSync(configPath)) {
    process.stdout.write(`${CONFIG_FILE} already exists at ${configPath} — leaving it untouched.\n`);
  } else {
    const template = { server: 'http://localhost:3000', repo_id: 0 };
    writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`);
    process.stdout.write(`Wrote ${configPath}. Edit "server" and "repo_id" to point at your Unitbob host.\n`);
  }

  ensureGitignored(cwd);
}

function ensureGitignored(cwd: string): void {
  const gitignorePath = join(cwd, GITIGNORE);
  let current = '';
  if (existsSync(gitignorePath)) {
    current = readFileSync(gitignorePath, 'utf8');
  }

  const lines = current.split('\n').map((line) => line.trim());
  const additions = [CONFIG_FILE, ARTIFACT_DIR].filter((line) => !lines.includes(line));
  if (additions.length === 0) return;

  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${current}${prefix}${additions.join('\n')}\n`);
  process.stdout.write(`Added ${additions.join(', ')} to ${GITIGNORE}.\n`);
}
