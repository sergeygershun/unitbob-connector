import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { publishAndRun } from '../src/cli.ts';
import { classifyPublication } from '../src/verbs/putSuiteBuild.ts';
import { runOnly } from '../src/verbs/run.ts';
import { outputPath, writeSuiteBuildRequest } from '../src/files/suiteBuild.ts';
import { writeConfigFile } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { SuiteBuildResult, SuiteListItem } from '../src/wire.ts';

// Spec 32-4. Publishing a suite and running it the first time are one operation
// now, because the second half used to be a separate LLM-directed command that a
// real session skipped: the suite was stored, nothing had ever run it, and the
// user was told about results that did not exist. These tests pin the sequence and
// the exit codes, not the wording.

function config(): Config {
  return {
    server: 'https://host',
    repoId: 3,
    token: 'secret-token',
    projectRoot: mkdtempSync(join(tmpdir(), 'unitbob-publish-run-')),
  };
}

function ok(kind: string, digest: string, status = 'created'): SuiteBuildResult {
  return { suite_kind: kind, status, suite_digest: digest, counts: {} };
}

type Calls = { digests: string[][]; out: string; errors: string };

function deps(results: SuiteBuildResult[] | Error, calls: Calls, over: { runOnly?: (config: Config, digests: string[]) => Promise<void> } = {}) {
  return {
    putSuiteBuild: async () => {
      if (results instanceof Error) throw results;
      return results;
    },
    runOnly: over.runOnly ?? (async (_config: Config, digests: string[]) => { calls.digests.push(digests); }),
    stdout: { write: (chunk: string) => { calls.out += chunk; return true; } },
    stderr: { write: (chunk: string) => { calls.errors += chunk; return true; } },
  };
}

function calls(): Calls {
  return { digests: [], out: '', errors: '' };
}

test('a whole upload failure never reaches the run', async () => {
  const seen = calls();

  await assert.rejects(
    () => publishAndRun(config(), [], deps(new Error('PUT /repos/3/suite_builds failed: 500'), seen)),
    /suite_builds failed/,
  );

  assert.deepEqual(seen.digests, []);
});

// Both peers rejected. The suite each branch was meant to replace is still stored
// and still current — running *that* would file honest results under a version the
// user never published.
test('zero published peers runs nothing and exits 1', async () => {
  const seen = calls();
  const results: SuiteBuildResult[] = [
    { suite_kind: 'structural', status: 'error', error: 'two capabilities share a marker' },
    { suite_kind: 'behavioral', status: 'build_error', error: 'cucumber is not installable here' },
  ];

  const code = await publishAndRun(config(), [], deps(results, seen));

  assert.equal(code, 1);
  assert.deepEqual(seen.digests, []);
  assert.match(seen.errors, /nothing was run/i);
});

test('one published peer plus one build_error runs only the published identity', async () => {
  const seen = calls();
  const results: SuiteBuildResult[] = [
    ok('structural', 'struct-d1'),
    { suite_kind: 'behavioral', status: 'build_error', error: 'no independent reviewer was available' },
  ];

  const code = await publishAndRun(config(), [], deps(results, seen));

  assert.equal(code, 0, 'partial publication whose run was accepted is a success');
  assert.deepEqual(seen.digests, [['struct-d1']]);
  // Said before the run summaries, so the reader cannot carry the structural
  // results over onto the branch that never published.
  assert.match(seen.out, /Partial success\. No run summary below covers: behavioral\./);
});

test('a full success says nothing about partial publication', async () => {
  const seen = calls();

  const code = await publishAndRun(config(), [], deps([ok('structural', 'struct-d1'), ok('behavioral', 'behav-d1')], seen));

  assert.equal(code, 0);
  assert.doesNotMatch(seen.out, /Partial/);
});

// Zero published is not "partial" — it is a failure, and it is already reported
// on stderr with a non-zero exit.
test('zero published peers is not labelled a partial success', async () => {
  const seen = calls();

  const code = await publishAndRun(config(), [], deps([
    { suite_kind: 'structural', status: 'error', error: 'markers collide' },
  ], seen));

  assert.equal(code, 1);
  assert.doesNotMatch(seen.out, /Partial/);
});

test('two published peers invoke the run once, with both identities', async () => {
  const seen = calls();

  const code = await publishAndRun(config(), [], deps([ok('structural', 'struct-d1'), ok('behavioral', 'behav-d1')], seen));

  assert.equal(code, 0);
  assert.deepEqual(seen.digests, [['struct-d1', 'behav-d1']]);
});

// A published-and-current version can arrive three ways: newly stored, already
// identical, or reactivated. All three are things to run. Anything else fails
// closed, so a newer server cannot talk an older connector into running a status
// it does not understand.
test('created, unchanged, and restored are the only statuses that run', () => {
  assert.deepEqual(
    classifyPublication([
      ok('structural', 'a', 'created'),
      ok('behavioral', 'b', 'unchanged'),
      ok('structural', 'c', 'restored'),
    ]),
    { digests: ['a', 'b', 'c'], unpublished: [] },
  );

  // One rule read both ways: whatever cannot be run is exactly what no result may
  // be claimed about, so the two lists are always complements.
  assert.deepEqual(
    classifyPublication([
      { suite_kind: 'structural', status: 'error', suite_digest: 'x' },
      { suite_kind: 'behavioral', status: 'build_error', suite_digest: 'y' },
      { suite_kind: 'structural', status: 'quarantined', suite_digest: 'z' },
    ]),
    { digests: [], unpublished: ['structural', 'behavioral', 'structural'] },
  );
});

// A success the server cannot name an identity for is not something to guess
// about: the suite is stored, so say that and let the standalone run recover.
test('a published status without an identity refuses to pick one', () => {
  assert.throws(
    () => classifyPublication([{ suite_kind: 'behavioral', status: 'created' }]),
    /returned no identity/,
  );
});

// The two requests are separate, so this is a composition and not a transaction.
// Nothing new was stored, so the earlier state stands and the standalone check
// finishes the job.
test('a run that aborts before upload exits 1 and points at the standalone check', async () => {
  const seen = calls();

  const code = await publishAndRun(config(), [], deps([ok('structural', 'struct-d1')], seen, {
    runOnly: async () => { throw new Error('POST /repos/3/runs/batch failed: connection reset'); },
  }));

  assert.equal(code, 1);
  assert.match(seen.errors, /connection reset/);
  assert.match(seen.errors, /The suite is published\. Run the Unitbob checks to finish\./);
});

// A runner that never produced a report is still a completed protocol exchange:
// the server stores the attempt and answers. The command succeeded even though
// the news is bad.
test('a structured suite error still exits 0 once the server accepts it', async () => {
  const seen = calls();
  const suite: SuiteListItem = {
    suite_kind: 'structural',
    status: 'ready',
    suite_digest: 'struct-d1',
    suite_file: { path: '.unitbob/structural/architecture_map_contracts_spec.rb', content: 'suite bytes' },
    runner_manifest: { runner: 'rspec', result_format: 'rspec_json' },
  };
  let uploaded: Array<Record<string, unknown>> = [];

  const code = await publishAndRun(config(), [], deps([ok('structural', 'struct-d1')], seen, {
    runOnly: (cfg, digests) =>
      runOnly(cfg, digests, {
        getSuites: async () => [suite],
        materializeStructural: () => {},
        validateStack: () => ({ ok: false, message: 'Ruby guardrails require RSpec, which was not found.' }),
        postRunsBatch: async (runs) => {
          uploaded = runs as Array<Record<string, unknown>>;
          return {
            results: [{ suite_kind: 'structural', suite_digest: 'struct-d1', status: 'error', summary: 'Internal structure checks could not run.' }],
            map_url: 'https://host/repos/3/map',
          };
        },
        stdout: { write: () => true },
      }),
  }));

  assert.equal(code, 0);
  assert.equal('suite_error' in uploaded[0], true);
});

// --- the whole command, as the user runs it ----------------------------------
//
// The tests above stub the two halves to pin the decisions between them. These
// two run the real binary in a child process against a real HTTP server: the only
// place that proves the exit code survives the trip out through `main` and
// `bin.ts`, and the only place that sees both sets of output — the publication
// lines, then the server's run summaries — in the order and from the sources
// spec 32-4 assigns them.
//
// A child process, not a hijacked `process.stdout`: node:test's own runner
// protocol travels over stdout, so capturing it in-process swallows the report
// (the same reason `ensureLinked` takes an injectable `out`).

const binPath = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
const execFileAsync = promisify(execFile);

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(projectRoot: string): Promise<CliRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, 'put-suite-build'], { cwd: projectRoot });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

// A built structural branch and a behavioral peer the host could not build — the
// partial shape spec 32-4 has to keep honest. The behavioral branch is a
// `build_error` rather than a real candidate because a real one would need its
// independent review, which is not what these tests are about.
function writeProject(projectRoot: string, server: string): void {
  writeConfigFile(projectRoot, { server, repo_id: 3, token: 'secret-token' });
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  writeSuiteBuildRequest(projectRoot, [
    {
      suite_kind: 'structural', source_digest: 'map-d', path_root: '.unitbob/structural/',
      recipe: { name: 'generate', version: 'g1', text: 'g' }, assignment: {},
    },
    {
      suite_kind: 'behavioral', source_digest: 'surface-d', path_root: '.unitbob/behavioral/',
      recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' }, assignment: {},
    },
  ]);
  writeFileSync(outputPath(projectRoot), JSON.stringify({
    branches: [
      {
        suite_kind: 'structural',
        suite_file: {
          path: '.unitbob/structural/architecture_map_contracts_spec.rb',
          content: "require_relative 'unitbob_helper'\n\nRSpec.describe 'x' do\nend\n",
        },
        runner_manifest: { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' },
        test_metadata: { capabilities: [] },
      },
      { suite_kind: 'behavioral', build_error: { message: 'no independent reviewer was available' } },
    ],
  }));
}

async function withServer(
  handler: (url: string, res: ServerResponse) => void,
  fn: (run: () => Promise<CliRun>, urls: string[]) => Promise<void>,
): Promise<void> {
  const urls: string[] = [];
  const server: Server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      urls.push(req.url ?? '');
      handler(req.url ?? '', res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const projectRoot = mkdtempSync(join(tmpdir(), 'unitbob-publish-run-cli-'));
  writeProject(projectRoot, `http://127.0.0.1:${port}`);

  try {
    await fn(() => runCli(projectRoot), urls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

test('the command exits 1 when nothing published, and never enters the run path', async () => {
  await withServer(
    (url, res) => {
      if (url === '/repos/3/suite_builds') {
        return json(res, 200, {
          results: [
            { suite_kind: 'structural', status: 'build_error', error: 'no supported stack here' },
            { suite_kind: 'behavioral', status: 'build_error', error: 'no independent reviewer was available' },
          ],
        });
      }
      return json(res, 500, { error: 'this endpoint must not be reached' });
    },
    async (run, urls) => {
      const { code, stdout, stderr } = await run();

      assert.equal(code, 1, 'a published-nothing outcome must survive out through main and bin');
      assert.deepEqual(urls, ['/repos/3/suite_builds'], 'the run path is never entered');
      assert.match(stdout, /structural: not published/);
      assert.match(stderr, /nothing was run/i);
    },
  );
});

test('a partial publication prints publication lines, the partial warning, the run summary, then the map URL', async () => {
  await withServer(
    (url, res) => {
      if (url === '/repos/3/suite_builds') {
        return json(res, 200, {
          results: [
            { suite_kind: 'structural', status: 'created', suite_digest: 'struct-d1', counts: { guarded: 2 } },
            { suite_kind: 'behavioral', status: 'build_error', error: 'no independent reviewer was available' },
          ],
        });
      }
      if (url === '/repos/3/suites') {
        return json(res, 200, {
          suites: [{
            suite_kind: 'structural',
            status: 'ready',
            suite_digest: 'struct-d1',
            suite_file: { path: '.unitbob/structural/architecture_map_contracts_spec.rb', content: 'suite bytes' },
            runner_manifest: { runner: 'rspec', result_format: 'rspec_json' },
          }],
        });
      }
      return json(res, 200, {
        results: [{
          suite_kind: 'structural', suite_digest: 'struct-d1', status: 'error',
          summary: 'Internal structure checks could not run.',
        }],
        map_url: 'http://host/repos/3/map',
      });
    },
    async (run, urls) => {
      const { code, stdout } = await run();

      // The temp project is not a Ruby app, so the runner never starts and the
      // branch uploads a structured suite error. The protocol exchange still
      // completed, so the command succeeded (spec 32-4, decision 10).
      assert.equal(code, 0);
      assert.deepEqual(urls, ['/repos/3/suite_builds', '/repos/3/suites', '/repos/3/runs/batch']);

      const publication = stdout.indexOf('structural: created');
      const notPublished = stdout.indexOf('behavioral: not published');
      const partial = stdout.indexOf('Partial success. No run summary below covers: behavioral.');
      const summary = stdout.indexOf('Internal structure checks could not run.');
      const mapUrl = stdout.indexOf('/repos/3/enter?next=%2Frepos%2F3%2Fmap#t=secret-token');

      assert.ok(publication >= 0, `publication line missing from:\n${stdout}`);
      assert.ok(notPublished > publication, 'both publication outcomes are reported');
      assert.ok(partial > notPublished, 'the partial label summarizes the publication lines above it');
      assert.ok(summary > partial, 'server run summaries come after, and only for what published');
      assert.ok(mapUrl > summary, 'the map URL closes the report');
    },
  );
});
