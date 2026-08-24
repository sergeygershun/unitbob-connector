import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestOf, failureSet, reportedFailures } from '../src/runner/failureDigest.ts';

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

// A skip reports the same thing on every run forever, so it can never be the
// evidence that a repair changed nothing — counting it would stop a branch whose
// only permanent case is a skip, while the repair was still fixing the rest.
test('junit failures and errors count; a skip never does', () => {
  const report = `<?xml version="1.0"?><testsuites><testsuite>
    <testcase classname="t" name="test_ubc_0123456789ab_pays" file="t.py"><failure message="AssertionError: 500">trace</failure></testcase>
    <testcase classname="t" name="test_ubc_ba9876543210_refunds" file="t.py"><skipped message="no db"/></testcase>
    <testcase classname="t" name="test_ubc_cafecafecafe_ok" file="t.py"/>
  </testsuite></testsuites>`;

  assert.deepEqual(failureSet('pytest', report), [
    { marker: 'ubc_0123456789ab', file: 't.py', message: 'AssertionError: 500' },
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

// Spec 37-2, criterion 5. The same parse, read for the question a person asks:
// which scenario, in which file, on which step, and what did it say. Until now
// the connector produced only the three fields the comparison needs, so the
// coordinator reopened the report itself with inline `node -e` and `python3` at
// 300,000 tokens of context a turn.

test('a reported cucumber failure names the scenario, its file, its step and all of the message', () => {
  const report = [
    { pickle: { id: 'p1', name: 'A shopper pays', uri: 'features/pay.feature', tags: [{ name: '@ubc_0123456789ab' }],
      steps: [{ id: 'ps1', text: 'the buyer confirms the cart' }, { id: 'ps2', text: 'the seller is paid' }] } },
    { testCase: { id: 'tc1', pickleId: 'p1', testSteps: [{ id: 's1', pickleStepId: 'ps1' }, { id: 's2', pickleStepId: 'ps2' }] } },
    { testCaseStarted: { id: 'run1', testCaseId: 'tc1' } },
    { testStepFinished: { testCaseStartedId: 'run1', testStepId: 's1', testStepResult: { status: 'PASSED' } } },
    { testStepFinished: { testCaseStartedId: 'run1', testStepId: 's2', testStepResult: { status: 'FAILED', message: 'expected 200, got 500\n  ./app/pay.rb:12' } } },
  ].map((line) => JSON.stringify(line)).join('\n');

  assert.deepEqual(reportedFailures('cucumber', report), [{
    marker: 'ubc_0123456789ab',
    file: 'features/pay.feature',
    message: 'expected 200, got 500',
    name: 'A shopper pays',
    step: 'the seller is paid',
    detail: 'expected 200, got 500\n  ./app/pay.rb:12',
  }]);
});

test('a reported pytest-bdd failure names the step our own plugin caught the exception in', () => {
  const report = JSON.stringify({
    version: 1,
    scenarios: [{
      name: 'A shopper pays', tags: ['ubc_0123456789ab'], status: 'failed',
      failure: 'AssertionError: 500 != 200\n  at conftest.py:9',
      steps: [
        { keyword: 'Given', text: 'a cart with one item', status: 'passed' },
        { keyword: 'When', text: 'the buyer confirms it', status: 'failed' },
      ],
    }],
  });

  assert.deepEqual(reportedFailures('pytest-bdd', report), [{
    marker: 'ubc_0123456789ab',
    file: '',
    message: 'AssertionError: 500 != 200',
    name: 'A shopper pays',
    step: 'When the buyer confirms it',
    detail: 'AssertionError: 500 != 200\n  at conftest.py:9',
  }]);
});

// The two runners with no notion of a step say so by leaving it empty, rather
// than by having something invented for them.
test('a reported rspec failure carries the full description and no step', () => {
  const reported = reportedFailures('rspec', rspec([A])) as NonNullable<ReturnType<typeof reportedFailures>>;

  assert.equal(reported[0].name, 'Unitbob ubc_0123456789ab guards something');
  assert.equal(reported[0].step, '');
  assert.match(reported[0].detail, /expected 200, got 500\n {2}\.\/app\/x\.rb:12/);
});

test("pytest's escaped message is unescaped for the reader and left alone for the comparison", () => {
  const report = '<testsuites><testsuite><testcase name="ubc_0123456789ab t" file="t.py">'
    + '<failure message="assert &quot;a&quot; &lt; &quot;b&quot;"/></testcase></testsuite></testsuites>';
  const reported = reportedFailures('pytest', report) as NonNullable<ReturnType<typeof reportedFailures>>;

  assert.equal(reported[0].detail, 'assert "a" < "b"');
  assert.equal(reported[0].message, 'assert &quot;a&quot; &lt; &quot;b&quot;');
  assert.equal(failureSet('pytest', report)?.[0].message, 'assert &quot;a&quot; &lt; &quot;b&quot;');
});

// The reader's extra fields must never reach the hash, or every branch would
// look like it had moved the first time a backtrace mentioned a new object id.
test('the digest ignores everything the reader was given', () => {
  const withDetail = failureSet('rspec', rspec([A])) as NonNullable<ReturnType<typeof failureSet>>;

  assert.deepEqual(Object.keys(withDetail[0]).sort(), ['file', 'marker', 'message']);
});

// A self-closing passing case immediately before a failing one used to be
// swallowed whole: the regex backtracked out of `/>` into the paired branch and
// took the next element with it, so the failure was reported under the passing
// case's name and file. Silent while the result was only hashed; wrong the
// moment spec 37-2 started printing it to somebody deciding what to repair.
test('a self-closing testcase does not swallow the one after it', () => {
  const report = '<testsuites><testsuite>'
    + '<testcase name="test_passes" file="t/b.py"/>'
    + '<testcase name="test_fails ubc_0123456789ab" file="t/c.py"><failure message="boom"/></testcase>'
    + '</testsuite></testsuites>';

  assert.deepEqual(failureSet('pytest', report), [{
    marker: 'ubc_0123456789ab',
    file: 't/c.py',
    message: 'boom',
  }]);
});

// pytest puts the one-line summary in `message=` and the assertion with its
// traceback in the element's body, escaped. The body is the half a person needs.
test("a junit failure's body reaches the reader, newlines and all", () => {
  const report = '<testsuites><testsuite><testcase name="ubc_0123456789ab t" file="t.py">'
    + '<failure message="assert 500 == 200">E  assert 500 == 200&#10;t.py:12: AssertionError</failure>'
    + '</testcase></testsuite></testsuites>';
  const reported = reportedFailures('pytest', report) as NonNullable<ReturnType<typeof reportedFailures>>;

  assert.equal(reported[0].detail, 'assert 500 == 200\nE  assert 500 == 200\nt.py:12: AssertionError');
  assert.equal(reported[0].message, 'assert 500 == 200');
});

test('a numeric reference nothing can decode is left as it was written', () => {
  const report = '<testsuites><testsuite><testcase name="t" file="t.py">'
    + '<failure message="bad &#1114112; ref"/></testcase></testsuite></testsuites>';
  const reported = reportedFailures('pytest', report) as NonNullable<ReturnType<typeof reportedFailures>>;

  assert.equal(reported[0].detail, 'bad &#1114112; ref');
});

// The bench this spec measures runs pytest-bdd, where the read-out used to name
// the Scenario and leave the reader to find the feature file themselves.
test('a pytest-bdd failure names the feature file its Scenario came from', () => {
  const report = JSON.stringify({
    version: 1,
    scenarios: [{
      name: 'A shopper pays', file: '.unitbob/behavioral/features/pay.feature',
      tags: ['ubc_0123456789ab'], status: 'failed', failure: 'AssertionError', steps: [],
    }],
  });

  assert.equal(reportedFailures('pytest-bdd', report)?.[0].file, '.unitbob/behavioral/features/pay.feature');
});

test('a pytest-bdd report from before that field still reads', () => {
  const report = JSON.stringify({
    version: 1,
    scenarios: [{ name: 'A shopper pays', tags: ['ubc_0123456789ab'], status: 'failed', failure: 'AssertionError' }],
  });

  assert.equal(reportedFailures('pytest-bdd', report)?.[0].file, '');
});
