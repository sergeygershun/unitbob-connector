// Release guard, half two: the version this repository points at must exist in npm.
//
// The plugin is served from this repository, not from the npm package
// (`package.json` publishes `dist` and nothing else), so `main` is what hosts
// execute. A `main` whose workflows say `npx -y unitbob@0.2.9` while npm's
// newest is 0.2.8 does not run someone's old code — it fails outright, because
// npm has no such version to fetch. That happened twice in one evening on
// 2026-08-02: 0.2.9 stood for ~50 minutes and 0.2.10 for ~3.5 hours, each
// bumped, committed, and never published.
//
// The offline half of this guard (`test/plugin_pins.test.ts`) checks the
// fourteen places agree with each other. They agreed the whole time. Only this
// half — asking the registry — sees the failure, which is why it cannot live in
// the test suite: the suite must run without a network.
//
// The order to keep: publish, then push. That is the order spec 33's DoD already
// asks for ("коннектор в npm → версия в плагине → мерж провода в main"),
// because the brain deploys itself from main and the reverse order breaks a live
// project.
//
// It used to be *enforced*, by a pre-push hook that ran this on any push to
// main. The hook was removed at the owner's request on 2026-08-06, so nothing
// blocks that order now and this is a command you choose to run:
//
//   npm run check:release
//
// The failure it was written for is unchanged; only the guard is gone.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `--revision <sha>` reads the manifest out of that commit instead of off the
// disk, for asking about a commit rather than about the working tree: an
// uncommitted bump would otherwise be checked while the pushed commit went
// unexamined, and a bump that is committed but reverted locally would sail
// through. Run by hand with no argument, the disk is the right answer and stays
// the default.
const flag = process.argv.indexOf('--revision');
const revision = flag === -1 ? null : process.argv[flag + 1];

const manifest = revision
  ? execFileSync('git', ['show', `${revision}:package.json`], { encoding: 'utf8' })
  : readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');

const { name, version } = JSON.parse(manifest);
const at = revision ? ` at ${revision.slice(0, 8)}` : '';

// Deliberately an escape hatch with a name you have to type, not a quiet
// fallback. A guard that lets itself off when the network hiccups is a guard
// that is absent precisely when a release is being rushed.
if (process.env.UNITBOB_SKIP_RELEASE_CHECK === '1') {
  console.log(`Release check skipped by UNITBOB_SKIP_RELEASE_CHECK for ${name}@${version}.`);
  process.exit(0);
}

// `published` is the list, or the process is already gone. Written as a function
// so "we could not ask" exits from one place and nothing below has to wonder
// whether `response` survived the failure path.
async function publishedVersions() {
  let response;
  try {
    response = await fetch(`https://registry.npmjs.org/${name}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    console.error(`Could not reach the npm registry to check ${name}@${version}${at}: ${error.message}`);
    console.error('Set UNITBOB_SKIP_RELEASE_CHECK=1 to push anyway, knowingly.');
    process.exit(2);
  }

  // 404 is an answer, not a failure to get one: the registry knows this name and
  // says there is nothing under it. A package that has never been published is
  // the strongest possible case of the thing this guard exists to stop.
  if (response.status === 404) return [];

  if (!response.ok) {
    console.error(`npm answered ${response.status} for ${name}. Cannot tell whether ${version} is published.`);
    process.exit(2);
  }

  return Object.keys((await response.json()).versions ?? {});
}

const published = await publishedVersions();

if (published.includes(version)) {
  console.log(`${name}@${version}${at} is published — the plugin's pins point at something that exists.`);
  process.exit(0);
}

console.error(`${name}@${version}${at} is NOT published to npm.`);
console.error('');
console.error("The plugin ships from this repository, so its `npx -y unitbob@<v>` lines are what hosts run.");
console.error(`Pushing this leaves them calling a version npm cannot fetch, and every command fails.`);
console.error('');
console.error(`  npm publish            # then push`);
console.error(`  UNITBOB_SKIP_RELEASE_CHECK=1 git push   # if you mean to push it unpublished`);
console.error('');
console.error(`Newest published: ${published.sort().slice(-3).join(', ') || '(none)'}`);
process.exit(1);
