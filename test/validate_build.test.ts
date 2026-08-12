import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSuiteBuildRequest, type SuiteBuildBranch } from '../src/files/suiteBuild.ts';
import { collectBuildProblems, validateBuild, validateBuildProblems } from '../src/verbs/validateBuild.ts';
import { WireError, type SuiteBuildItem, type SuiteBuildResult } from '../src/wire.ts';
import type { Config } from '../src/config.ts';

// Spec 42. This command used to predict the server's verdict from a local copy
// of its rules; it now asks the server for that verdict with a dry run. So the
// tests here are of two kinds and no others:
//
//   - the checks the server *cannot* make, because it has neither the files nor
//     the request: the files exist and sit under `.unitbob/`, and every branch
//     the request asked for has an entry;
//   - what the command does with the server's answer, including the two ways it
//     can fail to get one — no server at all, and a server too old to know what
//     a dry run is.
//
// The removed tests are not a loss of coverage. They asserted a second
// implementation of rules that live on the server, and on 2026-08-12 that second
// implementation passed four answers the server then refused.

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-validate-build-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

const MANIFEST = { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' };

const ASSIGNMENT = {
  blocks: [{
    block_id: 'billing',
    interfaces: [
      { interface_id: 'charge', contract_key: 'contract:charge', case_marker: 'ubc_aaaaaaaaaaaa' },
      { interface_id: 'refund', contract_key: 'contract:refund', case_marker: 'ubc_bbbbbbbbbbbb' },
    ],
  }],
};

function request(): SuiteBuildBranch[] {
  return [{
    suite_kind: 'structural',
    source_digest: 'map-d',
    path_root: '.unitbob/structural/',
    recipe: { name: 'generate', version: 'g1', text: 'g' },
    assignment: ASSIGNMENT,
    runner_manifest: MANIFEST,
  }];
}

function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    suite_kind: 'structural',
    suite_file: {
      path: '.unitbob/structural/architecture_map_contracts_spec.rb',
      content: "it 'charges [ubc_aaaaaaaaaaaa]' do\nend\nit 'refunds [ubc_bbbbbbbbbbbb]' do\nend\n",
    },
    runner_manifest: MANIFEST,
    test_metadata: { capabilities: [
      { interface_id: 'charge', status: 'covered', contract_key: 'contract:charge', case_marker: 'ubc_aaaaaaaaaaaa' },
      { interface_id: 'refund', status: 'covered', contract_key: 'contract:refund', case_marker: 'ubc_bbbbbbbbbbbb' },
    ] },
    ...overrides,
  };
}

function problems(branch: Record<string, unknown>): string[] {
  const built = writeSuiteBuildRequest(tmpProject(), request());
  return collectBuildProblems(built, [branch as never]).map((problem) => problem.message);
}

// The whole answer written to disk, so the read path (safe paths, files that
// exist, a parseable envelope) is exercised alongside the branch accounting.
function onDisk(branch: Record<string, unknown>): string[] {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  const built = writeSuiteBuildRequest(projectRoot, request());
  writeFileSync(built.output_path, JSON.stringify({ branches: [branch] }));
  return validateBuildProblems(config(projectRoot)).map((problem) => problem.message);
}

// A project with the request and the answer already on disk, ready to run the
// verb against a stubbed server.
function projectWith(branches: Record<string, unknown>[], issued: SuiteBuildBranch[] = request()): string {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  const built = writeSuiteBuildRequest(projectRoot, issued);
  writeFileSync(built.output_path, JSON.stringify({ branches }));
  return projectRoot;
}

interface Asked {
  items: SuiteBuildItem[][];
  output: string;
}

async function run(
  projectRoot: string,
  answerWith: (items: SuiteBuildItem[]) => Promise<SuiteBuildResult[]>,
): Promise<Asked> {
  const asked: Asked = { items: [], output: '' };
  await validateBuild(config(projectRoot), [], {
    dryRun: async (items) => { asked.items.push(items); return answerWith(items); },
    stdout: { write: (chunk) => { asked.output += chunk; return true; } },
  });
  return asked;
}

const wouldPublish = (kind: string): SuiteBuildResult => ({
  suite_kind: kind,
  status: 'would_publish',
  counts: { covered: 2, unguarded: 0, blocks: 1 },
});

test('an answer whose files read cleanly has nothing local to report', () => {
  assert.deepEqual(problems(answer()), []);
});

test('an answer read from disk validates the same way', () => {
  assert.deepEqual(onDisk(answer()), []);
});

// A branch the host says plainly it could not build is an answer, not a
// malformed one. The server records it as such and the peer branch is untouched.
test('a branch that reports a build_error is not held to any of this', () => {
  assert.deepEqual(problems({ suite_kind: 'structural', build_error: { message: 'no stack' } }), []);
});

// --- the server's verdict, asked for rather than predicted -------------------

test('the answer goes to the server as a dry run, and its verdict is what the verb reports', async () => {
  const asked = await run(projectWith([answer()]), async () => [wouldPublish('structural')]);

  assert.equal(asked.items.length, 1);
  assert.equal(asked.items[0][0].suite_kind, 'structural');
  assert.equal(asked.items[0][0].source_digest, 'map-d', 'the digest comes from the request, never the answer');
  assert.deepEqual(asked.items[0][0].artifacts?.runner_manifest, MANIFEST);
  assert.match(asked.output, /would publish it/);
  assert.match(asked.output, /2 covered/);
});

// ADR 0001: a check that does not run everything it predicts says what it left
// out. The three are fixed, closed, and none of them can reject an artifact —
// which is why they are one line of output and not a field in the protocol.
test('the verb names what a dry run does not do', async () => {
  const asked = await run(projectWith([answer()]), async () => [wouldPublish('structural')]);

  assert.match(asked.output, /deduplication by digest/);
  assert.match(asked.output, /current pointer/);
  assert.match(asked.output, /parent digest/);
  assert.match(asked.output, /None of the three can reject an artifact/);
});

// Verbatim. Rewording the server's refusal here is where a third implementation
// of a rule begins: the reader then acts on this file's idea of what the server
// meant, and the two drift the first time either changes.
test('a refusal is passed through in the server own words', async () => {
  const projectRoot = projectWith([answer()]);

  await assert.rejects(
    run(projectRoot, async () => [{
      suite_kind: 'structural',
      status: 'error',
      error: 'no guardrail returned for capability(ies): refund',
    }]),
    (err: Error) => {
      assert.match(err.message, /would refuse this answer/);
      assert.match(err.message, /no guardrail returned for capability\(ies\): refund/);
      return true;
    },
  );
});

// Declining a branch is an answer the server accepts, not one it refuses — and
// not one that publishes anything either, so saying "would publish it" over an
// answer that stores nothing would be the only untrue sentence in the report.
test('a branch the host declined is accepted, and named as publishing nothing', async () => {
  const asked = await run(
    projectWith([{ suite_kind: 'structural', build_error: { message: 'no stack' } }]),
    async () => [{ suite_kind: 'structural', status: 'build_error', error: 'no stack' }],
  );

  assert.match(asked.output, /accepted this answer, and it publishes no suite/);
  assert.doesNotMatch(asked.output, /would refuse/);
});

// Spec 42, §3.4, and ADR 0001 in one line: with no server the command succeeds,
// because there is no verdict to report — and it says which questions therefore
// went unasked. The silent "your suite answer looks well-formed" this replaces
// is the sentence that twice preceded a refusal on a2time.
test('no server is a success that says out loud what went unchecked', async () => {
  const asked = await run(projectWith([answer()]), async () => {
    throw new WireError('Cannot reach the Unitbob server at https://host (fetch failed).', { unreachable: true });
  });

  assert.match(asked.output, /was not asked for a verdict/);
  assert.match(asked.output, /Unchecked, therefore/);
  assert.match(asked.output, /case markers/);
  assert.doesNotMatch(asked.output, /looks well-formed/);
  assert.doesNotMatch(asked.output, /would publish it/);
});

// A server that answered is a verdict, however unwelcome. Only the absence of a
// server is an absence.
test('a server that answers with an error still stops the command', async () => {
  await assert.rejects(
    run(projectWith([answer()]), async () => {
      throw new WireError('PUT /repos/3/suite_builds failed: 500.');
    }),
    /failed: 500/,
  );
});

// The one accident this command could cause. A server older than `dry_run`
// ignores the flag and publishes — and the recipe allows exactly one
// publication, so reporting "the check passed" would be the worst available
// answer.
test('a server too old to know dry runs is reported as having published, not as a pass', async () => {
  await assert.rejects(
    run(projectWith([answer()]), async () => [{
      suite_kind: 'structural',
      status: 'created',
      suite_version_id: 7,
      suite_digest: 'abc',
    }]),
    (err: Error) => {
      assert.match(err.message, /does not know dry runs/);
      assert.match(err.message, /now live/);
      return true;
    },
  );
});

// --- the branch that is not there at all -------------------------------------

// Reading an entry tells you whether what arrived is well-formed; it cannot see
// a branch the answer never mentions. This walks the request instead.
//
// The a2time run of 2026-08-04 is why: its behavioral branch was prepared,
// half-built and abandoned for budget, the answer went up with the structural
// branch alone, and this check called it well-formed. ADR 1's "narrower" half —
// a pre-check that passes work the real thing would not. The server cannot close
// it: it judges each branch it receives, and this is about one it never got.
function twoBranchRequest(): SuiteBuildBranch[] {
  return [
    ...request(),
    {
      suite_kind: 'behavioral',
      source_digest: 'surface-d',
      path_root: '.unitbob/behavioral/',
      recipe: { name: 'generate_behavioral', version: 'b1', text: 'b' },
      assignment: {},
    },
  ];
}

function twoBranchProblems(
  answered: Record<string, unknown>[],
  unreadable: { suite_kind: string; message: string }[] = [],
): { branch: string; message: string }[] {
  const built = writeSuiteBuildRequest(tmpProject(), twoBranchRequest());
  return collectBuildProblems(built, answered as never[], unreadable);
}

test('a branch the request issued and the answer omits is named, not passed', () => {
  const found = twoBranchProblems([answer()]);

  assert.equal(found.length, 1);
  assert.equal(found[0].branch, 'behavioral');
  assert.match(found[0].message, /no entry for it/);
  // The message has to say what to do instead, or it just renames the dead end.
  assert.match(found[0].message, /"suite_kind": "behavioral", "build_error"/);
});

// Declining a branch is a first-class answer and stays cheap: one line, no
// suite. The check demands the sentence, never the work.
test('a branch declined with build_error is answered, not missing', () => {
  const found = twoBranchProblems([
    answer(),
    { suite_kind: 'behavioral', build_error: { message: 'ran out of budget after the feature file' } },
  ]);

  assert.deepEqual(found, []);
});

// One mistake, one complaint. A branch whose entry existed but would not parse
// is already reported as unreadable by the caller; adding "and it is missing"
// sends the reader looking for a second problem that is not there.
test('an unreadable branch is not also reported as missing', () => {
  const found = twoBranchProblems([answer()], [{ suite_kind: 'behavioral', message: 'malformed' }]);

  assert.deepEqual(found, []);
});

// A local problem stops the command before the server is asked: there is nothing
// coherent to ask about yet, and a server verdict on half an answer would read
// as a verdict on the answer.
test('the verb refuses a one-branch answer to a two-branch request without asking the server', async () => {
  const projectRoot = projectWith([answer()], twoBranchRequest());
  let asked = false;

  await assert.rejects(
    validateBuild(config(projectRoot), [], {
      dryRun: async () => { asked = true; return []; },
      stdout: { write: () => true },
    }),
    (err: Error) => {
      assert.match(err.message, /behavioral: the request asked for this branch/);
      assert.match(err.message, /checks the server cannot make/);
      return true;
    },
  );
  assert.equal(asked, false);
});

// `validate-build` runs at step 10, before the run and before the review, so the
// behavioral review usually does not exist yet. That is not a fault in the
// answer — it is a question this check cannot ask yet, and ADR 0001 asks for it
// to be named rather than swallowed.
test('a behavioral branch whose review is not written yet is checked, and the gap is named', async () => {
  const behavioral = {
    suite_kind: 'behavioral',
    suite_file: {
      path: '.unitbob/behavioral/features/surface_contracts.feature',
      content: '@ubc_aaaaaaaaaaaa\nScenario: charges\n',
      support_files: [{ path: '.unitbob/behavioral/step_definitions/s_steps.rb', content: 'x\n' }],
    },
    runner_manifest: MANIFEST,
    test_metadata: { capabilities: [] },
  };
  const issued = [twoBranchRequest()[1]];
  const asked = await run(projectWith([behavioral], issued), async () => [wouldPublish('behavioral')]);

  assert.match(asked.output, /Not checked — behavioral: the independent review has not been written yet/);
  assert.match(asked.output, /run this command again afterwards/);
  assert.equal(asked.items[0].length, 1, 'the branch is still sent, minus the review');
});

// The opposite case, and the one that matters on the second run. A review that
// exists and will not bind — written against a different candidate, missing its
// quality review — is not a question this command cannot ask yet; it is the
// answer `put-suite-build` will block the branch on. Reporting it as "not
// written yet" would hand back a green verdict for a branch about to be refused.
test('a review that exists and will not bind is a problem, not a gap', async () => {
  const behavioral = {
    suite_kind: 'behavioral',
    suite_file: {
      path: '.unitbob/behavioral/features/surface_contracts.feature',
      content: '@ubc_aaaaaaaaaaaa\nScenario: charges\n',
      support_files: [{ path: '.unitbob/behavioral/step_definitions/s_steps.rb', content: 'x\n' }],
    },
    runner_manifest: MANIFEST,
    test_metadata: { capabilities: [] },
  };
  const projectRoot = projectWith([behavioral], [twoBranchRequest()[1]]);
  writeFileSync(
    join(projectRoot, '.unitbob', 'suite-build', 'behavioral_review.json'),
    JSON.stringify({ candidate_digest: 'f'.repeat(64), bdd_quality_review: {}, known_defect_probe: {} }),
  );
  let asked = false;

  await assert.rejects(
    validateBuild(config(projectRoot), [], {
      dryRun: async () => { asked = true; return []; },
      stdout: { write: () => true },
    }),
    (err: Error) => {
      assert.match(err.message, /behavioral: /);
      assert.match(err.message, /candidate/i);
      assert.doesNotMatch(err.message, /has not been written yet/);
      return true;
    },
  );
  assert.equal(asked, false, 'a branch that cannot be assembled is not sent for a verdict');
});
