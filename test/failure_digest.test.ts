import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestOf, failureSet } from '../src/runner/failureDigest.ts';

// Spec 34-6, criterion 3. The comparison is only worth anything if it is stable
// against everything that differs between two runs of the same broken suite —
// execution order, seeds, backtraces — and sensitive to the one thing that means
// the repair moved: what the failure now says.

function rspec(examples: Record<string, unknown>[]): string {
  return JSON.stringify({ examples });
}

function example(marker: string, file: string, message: string): Record<string, unknown> {
  return {
    description: `${marker} guards something`,
    full_description: `Unitbob ${marker} guards something`,
    file_path: file,
    status: 'failed',
    exception: { message, backtrace: ['./a_spec.rb:4', './b.rb:88'] },
  };
}

const A = example('ubc_0123456789ab', './a_spec.rb', 'expected 200, got 500\n  ./app/x.rb:12:in `call\'');
const B = example('ubc_ba9876543210', './b_spec.rb', 'undefined method `total\'\n  ./app/y.rb:3');

test('a report the runner never wrote is no set at all, not an empty one', () => {
  assert.equal(failureSet('rspec', ''), null);
  assert.equal(failureSet('rspec', '   '), null);
  assert.equal(failureSet('rspec', 'this is not json'), null);
});

test('a green report is an empty set, which is different from no set', () => {
  assert.deepEqual(failureSet('rspec', rspec([])), []);
});

test('passing examples are not failures', () => {
  const report = rspec([{ description: 'ubc_0123456789ab ok', file_path: './a_spec.rb', status: 'passed' }]);

  assert.deepEqual(failureSet('rspec', report), []);
});

test('a failure is its marker, its file and the first line of its message', () => {
  assert.deepEqual(failureSet('rspec', rspec([A])), [{
    marker: 'ubc_0123456789ab',
    file: './a_spec.rb',
    message: 'expected 200, got 500',
  }]);
});

// The whole point. A runner that reorders its examples between runs would
// otherwise look like a repair that achieved something.
test('the order the runner reported the failures in does not change the digest', () => {
  const forwards = failureSet('rspec', rspec([A, B])) as NonNullable<ReturnType<typeof failureSet>>;
  const backwards = failureSet('rspec', rspec([B, A])) as NonNullable<ReturnType<typeof failureSet>>;

  assert.deepEqual(forwards, backwards);
  assert.equal(digestOf(forwards), digestOf(backwards));
});

test('a message whose first line changed is a different set', () => {
  const before = failureSet('rspec', rspec([A])) as NonNullable<ReturnType<typeof failureSet>>;
  const after = failureSet(
    'rspec',
    rspec([example('ubc_0123456789ab', './a_spec.rb', 'expected 200, got 422\n  ./app/x.rb:12')]),
  ) as NonNullable<ReturnType<typeof failureSet>>;

  assert.notEqual(digestOf(before), digestOf(after));
});

// Backtraces carry line numbers of the generated file, which move whenever the
// repair worker edits anything at all above the failure. Keeping them would make
// every run look like progress.
test('a backtrace below the first line does not enter the digest', () => {
  const one = failureSet('rspec', rspec([A])) as NonNullable<ReturnType<typeof failureSet>>;
  const other = failureSet(
    'rspec',
    rspec([example('ubc_0123456789ab', './a_spec.rb', 'expected 200, got 500\n  ./app/x.rb:940:in `other\'')]),
  ) as NonNullable<ReturnType<typeof failureSet>>;

  assert.equal(digestOf(one), digestOf(other));
});

test('one failure fixed out of two is a different set', () => {
  const both = failureSet('rspec', rspec([A, B])) as NonNullable<ReturnType<typeof failureSet>>;
  const one = failureSet('rspec', rspec([A])) as NonNullable<ReturnType<typeof failureSet>>;

  assert.notEqual(digestOf(both), digestOf(one));
});

test('vitest failures read the same way', () => {
  const report = JSON.stringify({
    testResults: [{
      name: '/repo/.unitbob/structural/x.test.ts',
      assertionResults: [
        { title: 'ubc_0123456789ab guards checkout', status: 'failed', failureMessages: ['expected 1 to be 2\n at x'] },
        { title: 'ubc_ba9876543210 guards refunds', status: 'passed', failureMessages: [] },
      ],
    }],
  });

  assert.deepEqual(failureSet('vitest', report), [{
    marker: 'ubc_0123456789ab',
    file: '/repo/.unitbob/structural/x.test.ts',
    message: 'expected 1 to be 2',
  }]);
});

// pytest's JUnit XML treats failure, error and skipped alike: none of them is a
// case that passed.
test('junit failures, errors and skips all count', () => {
  const report = `<?xml version="1.0"?><testsuites><testsuite>
    <testcase classname="t" name="test_ubc_0123456789ab_pays" file="t.py"><failure message="AssertionError: 500">trace</failure></testcase>
    <testcase classname="t" name="test_ubc_ba9876543210_refunds" file="t.py"><skipped message="no db"/></testcase>
    <testcase classname="t" name="test_ubc_cafecafecafe_ok" file="t.py"/>
  </testsuite></testsuites>`;

  assert.deepEqual(failureSet('pytest', report), [
    { marker: 'ubc_0123456789ab', file: 't.py', message: 'AssertionError: 500' },
    { marker: 'ubc_ba9876543210', file: 't.py', message: 'no db' },
  ]);
});

test('cucumber messages resolve a scenario through its pickle', () => {
  const report = [
    { pickle: { id: 'p1', name: 'A shopper pays', uri: 'features/pay.feature', tags: [{ name: '@ubc_0123456789ab' }] } },
    { testCase: { id: 'tc1', pickleId: 'p1', testSteps: [{ id: 's1', pickleStepId: 'ps1' }] } },
    { testCaseStarted: { id: 'run1', testCaseId: 'tc1' } },
    { testStepFinished: { testCaseStartedId: 'run1', testStepId: 's1', testStepResult: { status: 'FAILED', message: 'expected 200\n  at step' } } },
  ].map((line) => JSON.stringify(line)).join('\n');

  assert.deepEqual(failureSet('cucumber', report), [{
    marker: 'ubc_0123456789ab',
    file: 'features/pay.feature',
    message: 'expected 200',
  }]);
});

test('a passing cucumber scenario contributes nothing', () => {
  const report = [
    { pickle: { id: 'p1', name: 'A shopper pays', uri: 'features/pay.feature', tags: [{ name: '@ubc_0123456789ab' }] } },
    { testCase: { id: 'tc1', pickleId: 'p1', testSteps: [{ id: 's1', pickleStepId: 'ps1' }] } },
    { testCaseStarted: { id: 'run1', testCaseId: 'tc1' } },
    { testStepFinished: { testCaseStartedId: 'run1', testStepId: 's1', testStepResult: { status: 'PASSED' } } },
  ].map((line) => JSON.stringify(line)).join('\n');

  assert.deepEqual(failureSet('cucumber', report), []);
});

test('the pytest-bdd report names no file, and identifies by marker and message', () => {
  const report = JSON.stringify({
    version: 1,
    scenarios: [
      { name: 'A shopper pays', tags: ['ubc_0123456789ab'], status: 'failed', failure: 'AssertionError\n  at step' },
      { name: 'A shopper refunds', tags: ['ubc_ba9876543210'], status: 'passed', failure: '' },
    ],
  });

  assert.deepEqual(failureSet('pytest-bdd', report), [{
    marker: 'ubc_0123456789ab',
    file: '',
    message: 'AssertionError',
  }]);
});

// A strategy this module has never been taught leaves the branch uncompared
// rather than compared wrongly — a wrong comparison stops a branch that is still
// making progress, which is the one failure mode worth engineering against here.
test('an unknown runner produces no set rather than a guess', () => {
  assert.equal(failureSet('some-future-runner', '{"examples":[]}'), null);
});
