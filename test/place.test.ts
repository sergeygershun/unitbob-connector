import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { readLocalExecContainer, writeConfigFile } from '../src/config.ts';
import { commandSucceedsInProject, placeProblem, runInProject } from '../src/runner/place.ts';
import { placeAdvice } from '../src/runner/placeAdvice.ts';
import { alignRunnerEnvironmentWithPlace } from '../src/runner/placeEnvironment.ts';

// Spec 36. The place a project's own processes run in: this machine, or a
// container the project names. Everything here is proved against a stand-in
// `docker` on PATH rather than a real daemon, because what is being pinned is
// what the connector *asks* docker for and what it does with the answer.

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-place-'));
}

// A `docker` that answers `container inspect` from a fixture, records every
// invocation, and returns whatever the test asked `exec` to return.
function fakeDocker(options: {
  mounts?: { Source: string; Destination: string }[];
  running?: boolean;
  inspectFails?: string;
  execCode?: number;
  execStderr?: string;
  // What `docker ps` lists. Every test names its containers differently on
  // purpose: an inspection is cached per container name for the life of the
  // process, so a shared name would answer the next test from this one.
  running_containers?: string[];
}): { record: string } {
  const bin = mkdtempSync(join(tmpdir(), 'unitbob-fake-docker-'));
  const record = join(bin, 'calls.txt');
  const container = JSON.stringify({
    State: { Running: options.running ?? true },
    Mounts: options.mounts ?? [],
  });

  const script = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(record)}
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then
  ${options.inspectFails
    ? `printf '%s\\n' ${JSON.stringify(options.inspectFails)} >&2; exit 1`
    : `printf '%s' ${JSON.stringify(container)}; exit 0`}
fi
if [ "$1" = "ps" ]; then printf '%b' ${JSON.stringify((options.running_containers ?? []).map((name) => `${name}\n`).join(''))}; exit 0; fi
if [ "$1" = "exec" ]; then
  ${options.execStderr ? `printf '%s\\n' ${JSON.stringify(options.execStderr)} >&2;` : ''}
  exit ${options.execCode ?? 0}
fi
exit 0
`;
  writeFileSync(join(bin, 'docker'), script);
  chmodSync(join(bin, 'docker'), 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  return { record };
}

function withExec(projectRoot: string, container: string): void {
  writeFileSync(
    join(projectRoot, '.unitbob.json'),
    JSON.stringify({ server: 'http://x', repo_id: 1, token: 't', exec: { docker: { container } } }, null, 2),
  );
}

function calls(record: string): string[] {
  return existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : [];
}

// Criterion 1, second half, and criterion 10's last line. A project with no
// `exec` must behave exactly as it did before this spec existed — which above
// all means paying nothing for a feature it does not use.
test('with no exec in the config, docker is never called and the command runs here', async () => {
  const projectRoot = tmpProject();
  const { record } = fakeDocker({});

  const result = await runInProject(projectRoot, 'sh', ['-c', 'printf ran']);

  assert.equal(result.command, 'sh');
  assert.equal(result.stdout, 'ran');
  assert.equal(commandSucceedsInProject(projectRoot, 'sh', ['-c', 'exit 0']), true);
  assert.equal(placeProblem(projectRoot), null);
  // Not `placeAdvice`: that one is the failure path, and looking for a container
  // to suggest is the whole of what it does.
  assert.deepEqual(calls(record), []);
});

// Criterion 1 and criterion 4. One field switches the place; the working
// directory is the project as the container sees it; and the variables that
// travel are the ones the connector named, never this machine's own.
test('in a container the command is wrapped, given the mounted root, and handed only the named variables', async () => {
  const projectRoot = tmpProject();
  withExec(projectRoot, 'shape-test');
  fakeDocker({ mounts: [{ Source: projectRoot, Destination: '/app' }] });

  const result = await runInProject(projectRoot, 'bin/rspec', ['--seed', '1'], {
    env: { RAILS_ENV: 'test', UNITBOB_REPO_ROOT: '/app' },
  });

  assert.equal(result.command, 'docker');
  assert.deepEqual(result.args, [
    'exec',
    '-w',
    '/app',
    '-e',
    'RAILS_ENV=test',
    '-e',
    'UNITBOB_REPO_ROOT=/app',
    'shape-test',
    'bin/rspec',
    '--seed',
    '1',
  ]);

  // The host's own environment stays on the host. A container has a PATH of its
  // own, and overwriting it hides the very `bundle` the image was built with.
  assert.equal(result.args.some((arg) => arg.startsWith('PATH=') || arg.startsWith('HOME=')), false);
});

// Criterion 1, third bullet. The path inside is derived, never asked for — and
// derived from the *deepest* mount that holds the project, because a monorepo
// mounts the parent and the project sits inside it.
test('the root inside the container comes from the deepest mount that holds the project', async () => {
  const projectRoot = tmpProject();
  withExec(projectRoot, 'deepest-mount');
  fakeDocker({
    mounts: [
      { Source: '/', Destination: '/host' },
      { Source: join(projectRoot, '..'), Destination: '/workspace' },
    ],
  });

  const result = await runInProject(projectRoot, 'true', []);
  const workingDirectory = result.args[result.args.indexOf('-w') + 1];

  assert.equal(workingDirectory, `/workspace/${projectRoot.split('/').pop()}`);
});

// Criterion 8. Docker's exit codes overlap with real runners' codes, so the
// code alone is never enough — but with the client's own words beside it, this
// is the harness failing and not the project.
test("docker's own failure is marked as the place's, and a runner's failure is not", async () => {
  const failing = tmpProject();
  withExec(failing, 'gone-away');
  fakeDocker({
    mounts: [{ Source: failing, Destination: '/app' }],
    execCode: 126,
    execStderr: 'Error response from daemon: container gone-away is not running',
  });
  const refused = await runInProject(failing, 'bin/rspec', []);
  assert.match(refused.placeFailure ?? '', /is not running/);

  const real = tmpProject();
  withExec(real, 'runner-said-no');
  fakeDocker({
    mounts: [{ Source: real, Destination: '/app' }],
    execCode: 127,
    execStderr: 'bin/rspec: line 3: bundle: command not found',
  });
  const runnerFailure = await runInProject(real, 'bin/rspec', []);
  assert.equal(runnerFailure.placeFailure, undefined);
});

// Criterion 7. Three refusals with three different fixes, said before anything
// is written — never one vague "the runner is unavailable".
test('an unusable place is refused in its own words', () => {
  const stopped = tmpProject();
  withExec(stopped, 'stopped-one');
  fakeDocker({ running: false, mounts: [{ Source: stopped, Destination: '/app' }] });
  assert.match(placeProblem(stopped) ?? '', /is not running.*docker start stopped-one/s);

  const absent = tmpProject();
  withExec(absent, 'never-existed');
  fakeDocker({ inspectFails: 'Error: No such container: never-existed' });
  assert.match(placeProblem(absent) ?? '', /no container of that name exists/);

  const copied = tmpProject();
  withExec(copied, 'no-mount');
  fakeDocker({ mounts: [{ Source: '/somewhere/else', Destination: '/app' }] });
  const message = placeProblem(copied) ?? '';
  assert.match(message, /not mounted into it/);
  assert.match(message, /copied in when the image was built/);
  assert.match(message, /Nothing was written and nothing was uploaded/);
});

// Criterion 6. An installed environment belongs to the place that installed it,
// and readiness here is decided by a file being on disk — so a macOS virtualenv
// would be taken for a finished Linux one.
test('a runner environment built somewhere else is replaced, and the generated suite is not', () => {
  const projectRoot = tmpProject();
  mkdirSync(join(projectRoot, '.unitbob', 'runners', '.venv', 'bin'), { recursive: true });
  writeFileSync(join(projectRoot, '.unitbob', 'runners', '.venv', 'bin', 'python'), '');
  mkdirSync(join(projectRoot, '.unitbob', 'behavioral', 'step_definitions'), { recursive: true });
  writeFileSync(join(projectRoot, '.unitbob', 'behavioral', 'Gemfile'), 'source "x"\n');
  writeFileSync(join(projectRoot, '.unitbob', 'behavioral', 'step_definitions', 'billing.rb'), '# steps\n');

  // First run on this machine: the mark is written, nothing is thrown away.
  assert.equal(alignRunnerEnvironmentWithPlace(projectRoot), null);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'runners', '.venv')), true);

  withExec(projectRoot, 'somewhere-else');
  fakeDocker({ mounts: [{ Source: projectRoot, Destination: '/app' }] });

  const said = alignRunnerEnvironmentWithPlace(projectRoot);
  assert.match(said ?? '', /container `somewhere-else`/);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'runners')), false);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'behavioral', 'Gemfile')), false);
  // The host wrote these. They are text, not an installed environment.
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'behavioral', 'step_definitions', 'billing.rb')), true);

  // And the same place twice does nothing at all.
  assert.equal(alignRunnerEnvironmentWithPlace(projectRoot), null);
});

// Criterion 10. The dead end names the container that already has this project,
// and hands over the exact line to paste — but never picks one for you.
test('a dead end on this machine names every container that already holds the project', () => {
  const projectRoot = tmpProject();
  fakeDocker({
    running_containers: ['already-has-it'],
    mounts: [{ Source: projectRoot, Destination: '/app' }],
  });

  const advice = placeAdvice(projectRoot) ?? '';
  assert.match(advice, /`already-has-it`/);
  assert.match(advice, /sees this project as `\/app`/);
  assert.match(advice, /"exec": \{"docker": \{"container": "already-has-it"\}\}/);
});

// Criterion 11. Once the place *is* a container, every "run this yourself"
// above is a command for in there — one sentence, and none of them rewritten.
test('with a container configured, the advice says where to run things by hand', () => {
  const projectRoot = tmpProject();
  withExec(projectRoot, 'run-it-here');
  fakeDocker({ mounts: [{ Source: projectRoot, Destination: '/app' }] });

  assert.match(placeAdvice(projectRoot) ?? '', /docker exec -it run-it-here <command>/);
});

// Task 2.1. This function runs on an ordinary re-link, and it used to write
// exactly three keys — so the one field this whole spec is about was disposable.
test('writing the link keeps every other key in the config file', () => {
  const projectRoot = tmpProject();
  withExec(projectRoot, 'keep-me');

  writeConfigFile(projectRoot, { server: 'http://new', repo_id: 9, token: 'fresh' });

  assert.equal(readLocalExecContainer(projectRoot), 'keep-me');
  const written = JSON.parse(readFileSync(join(projectRoot, '.unitbob.json'), 'utf8'));
  assert.equal(written.server, 'http://new');
  assert.equal(written.repo_id, 9);
});
