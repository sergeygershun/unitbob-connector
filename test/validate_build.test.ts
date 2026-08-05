import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSuiteBuildRequest, type SuiteBuildBranch } from '../src/files/suiteBuild.ts';
import { collectBuildProblems, validateBuild, validateBuildProblems } from '../src/verbs/validateBuild.ts';
import type { Config } from '../src/config.ts';

// Spec 32-6 Phase 3. Every check here was already being made — by the server, at
// the end, after the suite had been written, run and reviewed. On the a2time run
// a format mistake made at 14:20 came back at 15:11. The checks are cheap; only
// their position in the loop was expensive.

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-validate-build-'));
}

function config(projectRoot: string): Config {
  return { server: 'https://host', repoId: 3, projectRoot };
}

const MANIFEST = { language: 'ruby', framework: 'rspec', result_format: 'rspec_json', runner: 'rspec' };

// Two assigned interfaces, so "answered twice" and "not answered at all" are
// both expressible. Markers are whatever the server minted; the host copies.
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

// A well-formed answer: both ids accounted for, markers copied, both markers
// present in the suite text.
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
// exist, a parseable envelope) is exercised alongside the comparisons.
function onDisk(branch: Record<string, unknown>): string[] {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  const built = writeSuiteBuildRequest(projectRoot, request());
  writeFileSync(built.output_path, JSON.stringify({ branches: [branch] }));
  return validateBuildProblems(config(projectRoot)).map((problem) => problem.message);
}

test('a well-formed answer has nothing to report', () => {
  assert.deepEqual(problems(answer()), []);
});

test('an answer read from disk validates the same way', () => {
  assert.deepEqual(onDisk(answer()), []);
});

// The field most likely to be rejected after all the work is done. After spec
// 32-5 the envelope comes down inside the request, so there is nothing to
// derive here — only to confirm it was copied.
test('a runner_manifest that differs from the issued one is caught', () => {
  const found = problems(answer({ runner_manifest: { ...MANIFEST, framework: 'minitest' } }));

  assert.equal(found.length, 1);
  assert.match(found[0], /runner_manifest does not match the one the request issued/);
  // Both sides are shown: "they differ" without saying how is another round trip.
  assert.match(found[0], /issued:/);
  assert.match(found[0], /answered:/);
});

test('an assigned id with no answer is caught', () => {
  const found = problems(answer({
    test_metadata: { capabilities: [
      { interface_id: 'charge', status: 'covered', contract_key: 'contract:charge', case_marker: 'ubc_aaaaaaaaaaaa' },
    ] },
  }));

  assert.deepEqual(found, ['no answer for 1 assigned id(s): refund.']);
});

test('an id answered twice is caught', () => {
  const twice = { interface_id: 'charge', status: 'covered', contract_key: 'contract:charge', case_marker: 'ubc_aaaaaaaaaaaa' };
  const found = problems(answer({ test_metadata: { capabilities: [twice, { ...twice }, {
    interface_id: 'refund', status: 'covered', contract_key: 'contract:refund', case_marker: 'ubc_bbbbbbbbbbbb',
  }] } }));

  assert.deepEqual(found, ['charge is answered 2 times — every assigned id is answered exactly once.']);
});

test('an id that was never assigned is caught', () => {
  const found = problems(answer({
    test_metadata: { capabilities: [
      ...(answer().test_metadata as { capabilities: unknown[] }).capabilities,
      { interface_id: 'invented', status: 'covered', contract_key: 'contract:invented', case_marker: 'ubc_cccccccccccc' },
    ] },
  }));

  assert.deepEqual(found, ['test_metadata names "invented", which is not in this branch\'s assignment.']);
});

// A marker is the only join between a runner's output and the map. One the host
// minted or edited severs it, and the failure shows up later as a mismatch
// blamed on the suite rather than on the edit.
test('an edited case_marker is caught', () => {
  const found = problems(answer({
    test_metadata: { capabilities: [
      { interface_id: 'charge', status: 'covered', contract_key: 'contract:charge', case_marker: 'ubc_999999999999' },
      { interface_id: 'refund', status: 'covered', contract_key: 'contract:refund', case_marker: 'ubc_bbbbbbbbbbbb' },
    ] },
  }));

  assert.equal(found.length, 1);
  assert.match(found[0], /charge carries case_marker "ubc_999999999999"/);
  assert.match(found[0], /never minted or edited locally/);
});

test('an edited contract_key is caught', () => {
  const found = problems(answer({
    test_metadata: { capabilities: [
      { interface_id: 'charge', status: 'covered', contract_key: 'contract:something_else', case_marker: 'ubc_aaaaaaaaaaaa' },
      { interface_id: 'refund', status: 'covered', contract_key: 'contract:refund', case_marker: 'ubc_bbbbbbbbbbbb' },
    ] },
  }));

  assert.equal(found.length, 1);
  assert.match(found[0], /contract_key "contract:something_else"/);
});

// Declared guarded, but the marker never made it into a test name. Without it
// there is nothing for a result to join to, so the capability reports as a
// mismatch instead of the green it claims.
test('a capability declared covered whose marker is nowhere in the suite is caught', () => {
  const found = problems(answer({
    suite_file: {
      path: '.unitbob/structural/architecture_map_contracts_spec.rb',
      content: "it 'charges [ubc_aaaaaaaaaaaa]' do\nend\n",
    },
  }));

  assert.deepEqual(found, ['refund is answered "covered", but its marker ubc_bbbbbbbbbbbb appears nowhere in the suite files.']);
});

test('an unguarded capability without a business reason is caught', () => {
  const found = problems(answer({
    test_metadata: { capabilities: [
      { interface_id: 'charge', status: 'covered', contract_key: 'contract:charge', case_marker: 'ubc_aaaaaaaaaaaa' },
      { interface_id: 'refund', status: 'unguarded', reason: '  ' },
    ] },
  }));

  assert.deepEqual(found, ['refund is unguarded but gives no business reason for it.']);
});

test('an unguarded capability with a reason is accepted, and needs no marker in the suite', () => {
  const found = problems(answer({
    suite_file: {
      path: '.unitbob/structural/architecture_map_contracts_spec.rb',
      content: "it 'charges [ubc_aaaaaaaaaaaa]' do\nend\n",
    },
    test_metadata: { capabilities: [
      { interface_id: 'charge', status: 'covered', contract_key: 'contract:charge', case_marker: 'ubc_aaaaaaaaaaaa' },
      { interface_id: 'refund', status: 'unguarded', reason: 'needs a live payment provider' },
    ] },
  }));

  assert.deepEqual(found, []);
});

test('a third answer that is neither covered nor unguarded is caught', () => {
  const found = problems(answer({
    test_metadata: { capabilities: [
      { interface_id: 'charge', status: 'covered', contract_key: 'contract:charge', case_marker: 'ubc_aaaaaaaaaaaa' },
      { interface_id: 'refund', status: 'partially' },
    ] },
  }));

  assert.deepEqual(found, ['refund must be answered "covered" or "unguarded" (got "partially").']);
});

// The point of the whole phase. "Fix one, learn the next" costs a round trip
// each time, and the round trip is what is expensive.
test('every problem is reported in one pass, not the first one', () => {
  const found = problems(answer({
    runner_manifest: { ...MANIFEST, framework: 'minitest' },
    test_metadata: { capabilities: [
      { interface_id: 'charge', status: 'covered', contract_key: 'contract:charge', case_marker: 'ubc_999999999999' },
    ] },
  }));

  assert.equal(found.length, 3, found.join('\n'));
  assert.ok(found.some((message) => /runner_manifest/.test(message)));
  assert.ok(found.some((message) => /case_marker/.test(message)));
  assert.ok(found.some((message) => /no answer for 1 assigned id\(s\): refund/.test(message)));
});

// --- which scenario reached which address (the a2time gap of 2026-08-04) -----
//
// The behavioral branch, whose assignment carries addresses. That run published
// 97 coverage rows against 99 Scenarios and this check said the answer looked
// fine; the independent reviewer found it hours later, doing a different job.

const BDD_MANIFEST = { language: 'ruby', framework: 'cucumber', result_format: 'cucumber_messages', runner: 'cucumber' };

function bddRequest(): SuiteBuildBranch[] {
  return [{
    suite_kind: 'behavioral',
    source_digest: 'map-d',
    path_root: '.unitbob/behavioral/',
    recipe: { name: 'generate', version: 'g1', text: 'g' },
    assignment: {
      capabilities: [{
        capability_id: 'clients',
        contract_key: 'contract:clients',
        case_marker: 'ubc_cccccccccccc',
        surfaces: ['GET /clients', 'POST /clients'],
      }],
    },
    runner_manifest: BDD_MANIFEST,
  }];
}

const FEATURE = [
  'Feature: What the product does',
  '',
  '  @ubc_cccccccccccc',
  '  Scenario: A partner opens the client list',
  '    Given a partner',
  '',
  '  @ubc_cccccccccccc',
  '  Scenario: A partner adds a client',
  '    Given a partner',
  '',
].join('\n');

const FULL_COVERAGE = [
  { scenario: 'A partner opens the client list', surfaces: ['GET /clients'] },
  { scenario: 'A partner adds a client', surfaces: ['POST /clients'] },
];

function bddAnswer(coverage: unknown): Record<string, unknown> {
  return {
    suite_kind: 'behavioral',
    suite_file: { path: '.unitbob/behavioral/features/surface_contracts.feature', content: FEATURE },
    runner_manifest: BDD_MANIFEST,
    test_metadata: { capabilities: [{
      capability_id: 'clients',
      status: 'covered',
      contract_key: 'contract:clients',
      case_marker: 'ubc_cccccccccccc',
      surface_coverage: coverage,
    }] },
  };
}

function bddProblems(coverage: unknown): string[] {
  const built = writeSuiteBuildRequest(tmpProject(), bddRequest());
  return collectBuildProblems(built, [bddAnswer(coverage) as never]).map((problem) => problem.message);
}

test('a complete coverage manifest is accepted', () => {
  assert.deepEqual(bddProblems(FULL_COVERAGE), []);
});

test('a scenario carrying the marker but named in no coverage row is caught', () => {
  const found = bddProblems([{ scenario: 'A partner opens the client list', surfaces: ['GET /clients', 'POST /clients'] }]);

  assert.ok(found.some((message) => /does not account for "A partner adds a client"/.test(message)), found.join('\n'));
});

// The second half of the same gap: the row is there and names nothing. Its
// siblings absorb every assigned address, so counting addresses finds nothing.
test('a coverage row naming no surface is caught even when its siblings cover everything', () => {
  const found = bddProblems([
    { scenario: 'A partner opens the client list', surfaces: ['GET /clients', 'POST /clients'] },
    { scenario: 'A partner adds a client', surfaces: [] },
  ]);

  assert.ok(found.some((message) => /names no surface for "A partner adds a client"/.test(message)), found.join('\n'));
});

test('an assigned address no scenario reaches is caught', () => {
  const found = bddProblems([
    { scenario: 'A partner opens the client list', surfaces: ['GET /clients'] },
    { scenario: 'A partner adds a client', surfaces: ['GET /clients'] },
  ]);

  assert.ok(found.some((message) => /accounts for no scenario at POST \/clients/.test(message)), found.join('\n'));
});

test('a coverage row naming an address this branch was never assigned is caught', () => {
  const found = bddProblems([
    FULL_COVERAGE[0],
    { scenario: 'A partner adds a client', surfaces: ['POST /clients', 'DELETE /clients/1'] },
  ]);

  assert.ok(found.some((message) => /names DELETE \/clients\/1/.test(message)), found.join('\n'));
});

test('a coverage row naming a scenario that is not in the suite is caught', () => {
  const found = bddProblems([...FULL_COVERAGE, { scenario: 'A partner invents a screen', surfaces: ['GET /clients'] }]);

  assert.ok(found.some((message) => /"A partner invents a screen", which appears nowhere/.test(message)), found.join('\n'));
});

// An older map's answer does not speak this language at all, and refusing it
// here would refuse what the server accepts.
test('an answer that declares no coverage at all is left to the server', () => {
  const built = writeSuiteBuildRequest(tmpProject(), bddRequest());
  const withoutCoverage = bddAnswer(undefined);
  const capability = ((withoutCoverage.test_metadata as Record<string, unknown>).capabilities as Record<string, unknown>[])[0];
  delete capability.surface_coverage;

  assert.deepEqual(collectBuildProblems(built, [withoutCoverage as never]), []);
});

// The structural branch carries no addresses, so none of this applies to it.
test('the structural branch is never asked about coverage', () => {
  assert.deepEqual(problems(answer()), []);
});

// A branch the host says plainly it could not build is an answer, not a
// malformed one. The server records it as such and the peer branch is untouched.
test('a branch that reports a build_error is not held to any of this', () => {
  assert.deepEqual(problems({ suite_kind: 'structural', build_error: { message: 'no stack' } }), []);
});

test('the verb says so plainly when the answer is well-formed', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  const built = writeSuiteBuildRequest(projectRoot, request());
  writeFileSync(built.output_path, JSON.stringify({ branches: [answer()] }));

  let output = '';
  await validateBuild(config(projectRoot), [], { stdout: { write: (chunk) => { output += chunk; return true; } } });

  assert.match(output, /looks well-formed/);
});

// The server is still the authority, and the message must not suggest otherwise:
// one of its four reasons to reject depends on time and cannot be answered here
// at all.
test('the verb fails with every problem at once, and defers to the server', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  const built = writeSuiteBuildRequest(projectRoot, request());
  writeFileSync(built.output_path, JSON.stringify({
    branches: [answer({ runner_manifest: { ...MANIFEST, framework: 'minitest' } })],
  }));

  await assert.rejects(validateBuild(config(projectRoot)), (err: Error) => {
    assert.match(err.message, /Your suite answer has 1 problem:/);
    assert.match(err.message, /has the last word/);
    return true;
  });
});

// The branch that is not there at all. Every other check in this file reads an
// entry and asks whether it is well-formed; none of them can see a branch the
// answer never mentions. This one walks the request instead.
//
// The a2time run of 2026-08-04 is why: its behavioral branch was prepared,
// half-built and abandoned for budget, the answer went up with the structural
// branch alone, and this check called it well-formed. ADR 1's "narrower" half —
// a pre-check that passes work the real thing would not.
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

test('the verb refuses a one-branch answer to a two-branch request', async () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'suite-build'), { recursive: true });
  const built = writeSuiteBuildRequest(projectRoot, twoBranchRequest());
  writeFileSync(built.output_path, JSON.stringify({ branches: [answer()] }));

  await assert.rejects(validateBuild(config(projectRoot)), (err: Error) => {
    assert.match(err.message, /behavioral: the request asked for this branch/);
    return true;
  });
});

// Spec 34, decision 15: an address only a third party can call is declared
// rather than faked. Mirrored from the server so this check never refuses an
// answer the upload would take — the one direction of drift that costs a branch.
function bddProblemsWith(capability: Record<string, unknown>): string[] {
  const built = writeSuiteBuildRequest(tmpProject(), bddRequest());
  const answer = bddAnswer(FULL_COVERAGE) as Record<string, unknown>;
  const metadata = answer.test_metadata as { capabilities: Record<string, unknown>[] };
  Object.assign(metadata.capabilities[0], capability);
  return collectBuildProblems(built, [answer as never]).map((problem) => problem.message);
}

test('a surface declared unreachable with a reason satisfies coverage', () => {
  const found = bddProblemsWith({
    surface_coverage: [{ scenario: 'A partner opens the client list', surfaces: ['GET /clients'] }],
    unreachable_surfaces: [{
      surface: 'POST /clients',
      reason: 'The vendor posts here after approving the account; no test can cause that.',
    }],
  });

  // The scenario that drives nothing is a separate, real complaint; what must
  // not appear is the address being reported as unaccounted for.
  assert.ok(!found.some((message) => /accounts for no scenario at POST \/clients/.test(message)), found.join('\n'));
});

// The per-address reason is the whole guard against this becoming the place
// every inconvenient address goes.
test('a surface declared unreachable without a reason is refused', () => {
  const found = bddProblemsWith({
    unreachable_surfaces: [{ surface: 'POST /clients' }],
  });

  assert.ok(found.some((message) => /POST \/clients unreachable but gives no business reason/.test(message)), found.join('\n'));
});

test('a surface both driven and declared unreachable is refused', () => {
  const found = bddProblemsWith({
    unreachable_surfaces: [{ surface: 'POST /clients', reason: 'A third party has to call this.' }],
  });

  assert.ok(found.some((message) => /both drives POST \/clients.*declares it unreachable/.test(message)), found.join('\n'));
});

test('an unreachable surface outside this assignment is refused', () => {
  const found = bddProblemsWith({
    unreachable_surfaces: [{ surface: 'GET /somebody_elses_callback', reason: 'A third party calls this.' }],
  });

  assert.ok(
    found.some((message) => /GET \/somebody_elses_callback, which this branch's assignment does not carry/.test(message)),
    found.join('\n'),
  );
});
