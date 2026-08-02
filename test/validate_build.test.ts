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
