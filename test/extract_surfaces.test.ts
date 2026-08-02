import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  describeRouteInventory,
  extractRouteInventory,
  inventoryProblems,
  routeInventoryPath,
  type RouteInventoryDeps,
  type RouteSurface,
} from '../src/surfaces/routeInventory.ts';
import { extractSurfaces } from '../src/verbs/extractSurfaces.ts';

// Spec 32-7. The addresses on the map must be the addresses the router
// declares — no more (a2time's invented `GET /work_time`) and no fewer (an
// address whose handler we cannot find is still an address). These tests hold
// both halves, and hold the silences: a stack with no router to ask, and an
// application that will not load, are normal answers, not failures.

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'unitbob-routes-'));
}

function railsProject(): string {
  const projectRoot = tmpProject();
  write(join(projectRoot, 'config', 'routes.rb'), 'Rails.application.routes.draw do\nend\n');
  return projectRoot;
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function withGraph(projectRoot: string, nodes: Array<Record<string, unknown>>): string {
  write(join(projectRoot, 'graphify-out', 'graph.json'), JSON.stringify({ nodes, links: [] }));
  return projectRoot;
}

function route(name: string, fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([key, value]) => `${key.padEnd(17)} | ${value}`)
    .join('\n');
  return `--[ Route ${name} ]${'-'.repeat(20)}\n${body}\n`;
}

type Canned = { code: number | null; stdout?: string; stderr?: string };

// One canned `rails routes` result per attempt, plus a record of what was asked
// to run and in which environment. A single result answers every attempt.
function router(result: Canned | Canned[] | Error): RouteInventoryDeps & {
  calls: string[];
  environments: Array<string | undefined>;
} {
  const calls: string[] = [];
  const environments: Array<string | undefined> = [];
  const queue = Array.isArray(result) ? [...result] : null;
  return {
    calls,
    environments,
    runCmd: async (command, args, options) => {
      calls.push(`${command} ${args.join(' ')}`);
      environments.push(options.env?.RAILS_ENV);
      if (result instanceof Error) throw result;
      const answer = queue ? (queue.shift() ?? { code: 1 }) : (result as Canned);
      return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
    },
  };
}

// What a successful run returns, so a test names only what it is about.
function written(
  projectRoot: string,
  fields: { routes: number; linked: number; environment?: 'test' | 'default' },
): unknown {
  return {
    status: 'written',
    path: routeInventoryPath(projectRoot),
    routes: fields.routes,
    linked: fields.linked,
    environment: fields.environment ?? 'test',
  };
}

function surfacesIn(projectRoot: string): RouteSurface[] {
  const written = JSON.parse(readFileSync(routeInventoryPath(projectRoot), 'utf8'));
  assert.equal(written.declared_by, 'rails routes');
  return written.surfaces as RouteSurface[];
}

test('the inventory is what the router printed, and the graph node id is copied whole', async () => {
  const projectRoot = withGraph(railsProject(), [
    // graphify's naming rule is its own — we never rebuild it, so an id of any
    // shape at all has to survive the trip unchanged.
    { id: 'controllers_settings_controller_settingscontroller_index', label: '.index()',
      source_file: 'app/controllers/settings_controller.rb' },
  ]);
  write(join(projectRoot, 'app', 'controllers', 'settings_controller.rb'), 'class SettingsController; end\n');
  const deps = router({
    code: 0,
    stdout: route('1', { Prefix: 'settings', Verb: 'GET', 'URI': '/settings(.:format)', 'Controller#Action': 'settings#index' }),
  });

  const result = await extractRouteInventory(projectRoot, deps);

  assert.deepEqual(result, written(projectRoot, { routes: 1, linked: 1 }));
  assert.deepEqual(surfacesIn(projectRoot), [
    {
      kind: 'route',
      id: 'GET /settings',
      source_file: 'app/controllers/settings_controller.rb',
      handler_symbol: 'controllers_settings_controller_settingscontroller_index',
      handler_label: 'settings#index',
    },
  ]);
  // The router is read in the environment the guardrail suite boots in.
  assert.match(deps.calls[0], /routes --expanded/);
  assert.deepEqual(deps.environments, ['test'], 'one question, in the environment the suite boots in');
});

// Review finding. The inventory must not be written into `surfaces.json` here,
// however cheap that looks: a file already full of routes reads as finished, and
// the job, table and external surfaces would never be looked for. The recipe
// makes `surfaces.json` from this file with one command — so it stays missing
// until the model starts, and `put-map-build` still refuses a build without it.
test('the router inventory is not passed off as the finished surfaces.json', async () => {
  const projectRoot = withGraph(railsProject(), []);
  const deps = router({
    code: 0,
    stdout: route('1', { Verb: 'GET', URI: '/settings(.:format)', 'Controller#Action': 'settings#index' }),
  });

  await extractRouteInventory(projectRoot, deps);

  assert.equal(existsSync(routeInventoryPath(projectRoot)), true);
  assert.equal(existsSync(join(projectRoot, '.unitbob', 'map-build', 'surfaces.json')), false);
});

// Review finding. `map-prepare` is the first command on a fresh checkout, long
// before the boot check of spec 32-6 provisions a test database. An application
// that touches the database while booting fails in `test` and starts perfectly
// in its default environment; calling that "your application did not load"
// sends somebody to debug a healthy app.
test('an application that will not boot in test is asked again in its default environment', async () => {
  const projectRoot = withGraph(railsProject(), []);
  const deps = router([
    { code: 1, stderr: 'ActiveRecord::NoDatabaseError: database "app_test" does not exist' },
    { code: 0, stdout: route('1', { Verb: 'GET', URI: '/settings(.:format)', 'Controller#Action': 'settings#index' }) },
  ]);

  const result = await extractRouteInventory(projectRoot, deps);

  assert.deepEqual(result, written(projectRoot, { routes: 1, linked: 0, environment: 'default' }));
  assert.deepEqual(deps.environments, ['test', undefined], 'the second attempt leaves RAILS_ENV alone');
  assert.equal(JSON.parse(readFileSync(routeInventoryPath(projectRoot), 'utf8')).environment, 'default');
  assert.match(describeRouteInventory(result), /read in the default environment/);
});

test('an application that will not boot anywhere quotes the default environment’s own words', async () => {
  const projectRoot = railsProject();
  const deps = router([
    { code: 1, stderr: 'ActiveRecord::NoDatabaseError: database "app_test" does not exist' },
    { code: 1, stderr: "app/models/user.rb:12:in `<class:User>': undefined method `validate_all' (NoMethodError)" },
  ]);

  const result = await extractRouteInventory(projectRoot, deps);

  assert.equal(result.status === 'silent' && result.reason, 'app_did_not_load');
  // Not the missing test database: if even the default environment will not
  // load, that is the failure worth showing.
  assert.match(result.status === 'silent' ? (result.detail ?? '') : '', /undefined method `validate_all'/);
});

test('an address the router never printed cannot reach the inventory', async () => {
  const projectRoot = withGraph(railsProject(), []);
  const deps = router({
    code: 0,
    stdout: route('1', { Verb: 'GET', 'URI': '/settings(.:format)', 'Controller#Action': 'settings#index' }),
  });

  await extractRouteInventory(projectRoot, deps);

  // a2time's `GET /work_time` was in the map and in no router. That class of
  // error ends here — on an application that loads.
  assert.deepEqual(surfacesIn(projectRoot).map((surface) => surface.id), ['GET /settings']);
});

test('one record with two verbs is two addresses; the same address twice is one', async () => {
  const projectRoot = withGraph(railsProject(), []);
  const deps = router({
    code: 0,
    stdout:
      route('1', { Verb: 'GET|POST', 'URI': '/search(.:format)', 'Controller#Action': 'search#run' }) +
      route('2', { Prefix: 'find', Verb: 'GET', 'URI': '/search(.:format)', 'Controller#Action': 'search#run' }),
  });

  await extractRouteInventory(projectRoot, deps);

  assert.deepEqual(surfacesIn(projectRoot).map((surface) => surface.id), ['GET /search', 'POST /search']);
});

test('a mounted Rack application is not an address of this application', async () => {
  const projectRoot = withGraph(railsProject(), []);
  const deps = router({
    code: 0,
    stdout:
      route('1', { Prefix: 'sidekiq_web', Verb: '', 'URI': '/sidekiq', 'Controller#Action': 'Sidekiq::Web' }) +
      route('2', { Verb: 'GET', 'URI': '/(.:format)', 'Controller#Action': 'home#show' }),
  });

  await extractRouteInventory(projectRoot, deps);

  assert.deepEqual(surfacesIn(projectRoot).map((surface) => surface.id), ['GET /']);
});

test('an address with no node behind it keeps its place, with no link', async () => {
  const projectRoot = withGraph(railsProject(), [
    // The parent holds the action; the child's own file has no `index` in it.
    { id: 'controllers_base_controller_basecontroller_index', label: '.index()',
      source_file: 'app/controllers/base_controller.rb' },
    { id: 'controllers_reports_controller_reportscontroller_show', label: '.show()',
      source_file: 'app/controllers/reports_controller.rb' },
  ]);
  write(join(projectRoot, 'app', 'controllers', 'reports_controller.rb'), 'class ReportsController; end\n');
  const deps = router({
    code: 0,
    stdout:
      // Inherited from a parent class, in another file.
      route('1', { Verb: 'GET', 'URI': '/reports(.:format)', 'Controller#Action': 'reports#index' }) +
      // Drawn by a template; there is no method in the controller at all.
      route('2', { Verb: 'GET', 'URI': '/reports/new(.:format)', 'Controller#Action': 'reports#new' }) +
      // A gem's own controller: graphify never saw that code, and the file is
      // not in this repository either.
      route('3', {
        Verb: 'GET',
        'URI': '/rails/active_storage/blobs/:signed_id/*filename(.:format)',
        'Controller#Action': 'active_storage/blobs/redirect#show',
      }),
  });

  const result = await extractRouteInventory(projectRoot, deps);

  assert.deepEqual(result, written(projectRoot, { routes: 3, linked: 0 }));
  assert.deepEqual(surfacesIn(projectRoot), [
    // The convention names the file and the file is really there, so it is said.
    { kind: 'route', id: 'GET /reports', source_file: 'app/controllers/reports_controller.rb',
      handler_label: 'reports#index' },
    { kind: 'route', id: 'GET /reports/new', source_file: 'app/controllers/reports_controller.rb',
      handler_label: 'reports#new' },
    // A gem's file is nowhere in this project, so nothing is claimed about it.
    { kind: 'route', id: 'GET /rails/active_storage/blobs/:signed_id/*filename',
      handler_label: 'active_storage/blobs/redirect#show' },
  ]);
});

// Captured from a real `bin/rails routes --expanded` (Rails 7.1). Rails 7 calls
// the path field `URI`; older versions call it `URI Pattern`, and which one a
// project prints is decided by its Gemfile, not by us.
const REAL_RAILS_7_OUTPUT = `--[ Route 1 ]-------------------------------------------------------------------
Prefix            | register_repos
Verb              | POST
URI               | /repos/register(.:format)
Controller#Action | repos#register
--[ Route 2 ]-------------------------------------------------------------------
Prefix            |
Verb              | GET
URI               | /rails/active_storage/blobs/:signed_id/*filename(.:format)
Controller#Action | active_storage/blobs/redirect#show
`;

test('real Rails output reads, under either name for the path field', async () => {
  const modern = withGraph(railsProject(), [
    { id: 'controllers_repos_controller_reposcontroller_register', label: '.register()',
      source_file: 'app/controllers/repos_controller.rb' },
  ]);

  await extractRouteInventory(modern, router({ code: 0, stdout: REAL_RAILS_7_OUTPUT }));

  assert.deepEqual(surfacesIn(modern), [
    { kind: 'route', id: 'POST /repos/register', source_file: 'app/controllers/repos_controller.rb',
      handler_symbol: 'controllers_repos_controller_reposcontroller_register',
      handler_label: 'repos#register' },
    { kind: 'route', id: 'GET /rails/active_storage/blobs/:signed_id/*filename',
      handler_label: 'active_storage/blobs/redirect#show' },
  ]);

  const older = withGraph(railsProject(), []);
  await extractRouteInventory(
    older,
    router({ code: 0, stdout: REAL_RAILS_7_OUTPUT.replace(/^URI {15}/gm, 'URI Pattern       ') }),
  );

  assert.deepEqual(surfacesIn(older).map((surface) => surface.id), [
    'POST /repos/register',
    'GET /rails/active_storage/blobs/:signed_id/*filename',
  ]);
});

test('a namespaced controller is found by its file and its method name', async () => {
  const projectRoot = withGraph(railsProject(), [
    { id: 'admin_users_index_node', label: 'Admin::UsersController#index',
      source_file: '/abs/path/app/controllers/admin/users_controller.rb' },
  ]);
  const deps = router({
    code: 0,
    stdout: route('1', { Verb: 'GET', 'URI': '/admin/users(.:format)', 'Controller#Action': 'admin/users#index' }),
  });

  await extractRouteInventory(projectRoot, deps);

  assert.deepEqual(surfacesIn(projectRoot), [
    {
      kind: 'route',
      id: 'GET /admin/users',
      source_file: '/abs/path/app/controllers/admin/users_controller.rb',
      handler_symbol: 'admin_users_index_node',
      handler_label: 'admin/users#index',
    },
  ]);
});

test('no graph costs the links, never the addresses', async () => {
  const projectRoot = railsProject();
  const deps = router({
    code: 0,
    stdout: route('1', { Verb: 'GET', 'URI': '/settings(.:format)', 'Controller#Action': 'settings#index' }),
  });

  const result = await extractRouteInventory(projectRoot, deps);

  assert.deepEqual(result, written(projectRoot, { routes: 1, linked: 0 }));
});

test('a stack with no router to ask says nothing and writes nothing', async () => {
  const projectRoot = tmpProject();
  writeFileSync(join(projectRoot, 'package.json'), '{}');
  const deps = router({ code: 0 });

  const result = await extractRouteInventory(projectRoot, deps);

  assert.deepEqual(result, { status: 'silent', reason: 'unsupported_stack' });
  assert.equal(existsSync(routeInventoryPath(projectRoot)), false);
  assert.deepEqual(deps.calls, [], 'nothing is started on a stack we cannot ask');
});

test('an application that will not load says nothing, in the runner’s own words', async () => {
  const projectRoot = railsProject();
  const deps = router({
    code: 1,
    stderr: 'app/models/user.rb:12:in `<class:User>\': undefined method `validate_all\' (NoMethodError)',
  });

  const result = await extractRouteInventory(projectRoot, deps);

  assert.equal(result.status, 'silent');
  assert.equal(result.status === 'silent' && result.reason, 'app_did_not_load');
  assert.match(
    result.status === 'silent' ? (result.detail ?? '') : '',
    /undefined method `validate_all'/,
  );
  assert.equal(existsSync(routeInventoryPath(projectRoot)), false);
});

test('a rails command that is not on the machine is another reason to say nothing', async () => {
  const projectRoot = railsProject();

  const result = await extractRouteInventory(projectRoot, router(new Error('spawn bundle ENOENT')));

  assert.deepEqual(result, {
    status: 'silent',
    reason: 'app_did_not_load',
    detail: 'the command did not run on this machine',
  });
});

test('output this version cannot read is not reported as an application with no addresses', async () => {
  const projectRoot = railsProject();

  const result = await extractRouteInventory(projectRoot, router({ code: 0, stdout: 'Prefix Verb URI Pattern\n' }));

  assert.deepEqual(result, { status: 'silent', reason: 'no_routes' });
  assert.equal(existsSync(routeInventoryPath(projectRoot)), false);
});

// Review finding. A node in another file that happens to end with the same path
// — an engine, a second app in a monorepo, a vendored copy — used to win on
// nothing but graph order. A wrong link is worse than no link: it would send a
// later trace into somebody else's code, and the host cannot catch it, because
// the node it names really does exist.
test('the file the router pointed at wins over one that merely ends the same way', async () => {
  const projectRoot = withGraph(railsProject(), [
    { id: 'engines_billing_users_index', label: '.index()',
      source_file: 'engines/billing/app/controllers/users_controller.rb' },
    { id: 'controllers_users_controller_userscontroller_index', label: '.index()',
      source_file: 'app/controllers/users_controller.rb' },
  ]);
  const deps = router({
    code: 0,
    stdout: route('1', { Verb: 'GET', URI: '/users(.:format)', 'Controller#Action': 'users#index' }),
  });

  await extractRouteInventory(projectRoot, deps);

  assert.equal(surfacesIn(projectRoot)[0].handler_symbol, 'controllers_users_controller_userscontroller_index');
});

test('two files ending the same way and no exact match leave the address unlinked', async () => {
  const projectRoot = withGraph(railsProject(), [
    { id: 'engines_billing_users_index', label: '.index()',
      source_file: 'engines/billing/app/controllers/users_controller.rb' },
    { id: 'engines_admin_users_index', label: '.index()',
      source_file: 'engines/admin/app/controllers/users_controller.rb' },
  ]);
  const deps = router({
    code: 0,
    stdout: route('1', { Verb: 'GET', URI: '/users(.:format)', 'Controller#Action': 'users#index' }),
  });

  const result = await extractRouteInventory(projectRoot, deps);

  // We cannot tell which file the router meant, so we claim neither.
  assert.deepEqual(result, written(projectRoot, { routes: 1, linked: 0 }));
});

// Implementation review. The exact-path rule used to take the first node that
// matched, while the suffix rule refused to choose — "whoever the graph listed
// first" is the very thing the exact rule exists to replace, and it survived
// one level down. Two classes in one file, or a graph listing a definition
// twice, land here.
test('two nodes naming the same file and the same method leave the address unlinked too', async () => {
  const projectRoot = withGraph(railsProject(), [
    { id: 'users_index_first', label: '.index()', source_file: 'app/controllers/users_controller.rb' },
    { id: 'users_index_second', label: '.index()', source_file: 'app/controllers/users_controller.rb' },
  ]);
  const deps = router({
    code: 0,
    stdout: route('1', { Verb: 'GET', URI: '/users(.:format)', 'Controller#Action': 'users#index' }),
  });

  const result = await extractRouteInventory(projectRoot, deps);

  assert.deepEqual(result, written(projectRoot, { routes: 1, linked: 0 }));
  assert.equal(surfacesIn(projectRoot)[0].handler_symbol, undefined, 'a wrong link is worse than none');
});

// An absolute path from the graph is still an exact match for the file the
// router named — the rule above must not undo the ordinary case.
test('an absolute path from the graph still counts as the file the router named', async () => {
  const projectRoot = withGraph(railsProject(), [
    { id: 'admin_users_index_node', label: '.index()',
      source_file: '/abs/path/app/controllers/admin/users_controller.rb' },
  ]);
  const deps = router({
    code: 0,
    stdout: route('1', { Verb: 'GET', URI: '/admin/users(.:format)', 'Controller#Action': 'admin/users#index' }),
  });

  await extractRouteInventory(projectRoot, deps);

  assert.equal(surfacesIn(projectRoot)[0].handler_symbol, 'admin_users_index_node');
});

test('a Rails too old for --expanded is not reported as an application that failed', async () => {
  const projectRoot = railsProject();

  const result = await extractRouteInventory(
    projectRoot,
    router({ code: 1, stderr: 'invalid option: --expanded' }),
  );

  assert.deepEqual(result, { status: 'silent', reason: 'router_too_old' });
  assert.equal(existsSync(routeInventoryPath(projectRoot)), false);
});

// Second review round. "invalid option" is ordinary Ruby wording and turns up
// in failing application code too. Reading it as an old Rails would print
// "nothing is wrong with the application" over a broken one — the same wrong
// errand `router_too_old` exists to prevent, sending the other way.
test('an application that fails with the words “invalid option” is not an old Rails', async () => {
  const projectRoot = railsProject();

  const result = await extractRouteInventory(
    projectRoot,
    router({ code: 1, stderr: "config/initializers/mailer.rb:4:in `<main>': invalid option: :tls (ArgumentError)" }),
  );

  assert.equal(result.status === 'silent' && result.reason, 'app_did_not_load');
});

// Second review round. `runProcess` reports a stopped process as no exit code
// at all: our two-minute timeout, or a signal from outside. A large application
// that needs longer has said nothing about its health, and "it did not load"
// would be us making the answer up.
test('a router that was stopped before it finished is not an application that failed to load', async () => {
  const projectRoot = railsProject();

  const result = await extractRouteInventory(
    projectRoot,
    router({ code: null, stderr: 'bin/rails timed out after 120000ms' }),
  );

  assert.deepEqual(result, { status: 'silent', reason: 'did_not_finish' });
  assert.equal(existsSync(routeInventoryPath(projectRoot)), false);
});

test('an inventory that cannot be written is a silence, not a crash', async () => {
  const projectRoot = railsProject();
  // A file where the `.unitbob/map-build` directory needs to be: mkdir fails.
  write(join(projectRoot, '.unitbob'), 'not a directory\n');
  const deps = router({
    code: 0,
    stdout: route('1', { Verb: 'GET', URI: '/settings(.:format)', 'Controller#Action': 'settings#index' }),
  });

  const result = await extractRouteInventory(projectRoot, deps);

  assert.equal(result.status, 'silent');
  assert.equal(result.status === 'silent' && result.reason, 'could_not_write');
});

// Review finding. Yesterday's addresses must not outlive the run that found
// them: a file of routes from a build when the application still booted looks
// exactly as authoritative as a fresh one, and sits in the folder the map build
// reads.
test('a run that says nothing takes the previous inventory with it', async () => {
  const projectRoot = withGraph(railsProject(), []);
  const good = router({
    code: 0,
    stdout: route('1', { Verb: 'GET', URI: '/old_address(.:format)', 'Controller#Action': 'old#index' }),
  });
  await extractRouteInventory(projectRoot, good);
  assert.equal(existsSync(routeInventoryPath(projectRoot)), true);

  // The next run: the application no longer boots.
  const result = await extractRouteInventory(projectRoot, router({ code: 1, stderr: 'boom' }));

  assert.equal(result.status, 'silent');
  assert.equal(existsSync(routeInventoryPath(projectRoot)), false, 'no stale answer is left behind');
});

// Run on its own, this verb is the first thing to write into `.unitbob/`. The
// folder is our bookkeeping and must not turn up in the vibecoder's commit.
test('the verb keeps .unitbob out of the project’s commits, as map-prepare does', async () => {
  const projectRoot = tmpProject(); // no router to ask: it stops before spawning anything
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await extractSurfaces({ server: 'https://host', repoId: 1, projectRoot });
  } finally {
    process.stdout.write = original;
  }

  assert.match(readFileSync(join(projectRoot, '.gitignore'), 'utf8'), /^\.unitbob\/$/m);
});

test('the sentence a vibecoder reads names the count, or names the reason', () => {
  assert.match(
    describeRouteInventory({
      status: 'written', path: '/p/route_inventory.json', routes: 218, linked: 194, environment: 'test',
    }),
    /218 addresses from the router, 194 tied to a graph node.*one command/,
  );
  assert.match(
    describeRouteInventory({ status: 'silent', reason: 'unsupported_stack' }),
    /no router Unitbob can ask yet.*extract_surfaces recipe reads the source instead/,
  );
  assert.match(
    describeRouteInventory({ status: 'silent', reason: 'app_did_not_load', detail: 'NoMethodError' }),
    /did not get through — NoMethodError/,
  );
  assert.match(describeRouteInventory({ status: 'silent', reason: 'no_routes' }), /nothing this version knows how to read/);
  // The sentence names both ways a run can be stopped, because a missing exit
  // code does not tell us which one happened.
  assert.match(
    describeRouteInventory({ status: 'silent', reason: 'did_not_finish' }),
    /stopped before it finished.*2-minute limit or something else killed it.*nothing here says the application is unhealthy/,
  );
  assert.match(
    describeRouteInventory({ status: 'silent', reason: 'router_too_old' }),
    /needs Rails 5\.1 or newer.*nothing is wrong with the application/,
  );
  assert.match(
    describeRouteInventory({ status: 'silent', reason: 'could_not_write', detail: 'EACCES' }),
    /could not be written — EACCES/,
  );
});

// Review finding. Until this check existed, the whole guarantee of the spec —
// the map carries the addresses the router declared, no others — rested on a
// sentence in a prompt. That is the mechanism that already failed on a2time,
// where the prompt said "never spell an id yourself" and the map still grew
// `GET /work_time`.
test('what the router declared and what the map claims are compared, id by id', () => {
  const inventory = {
    surfaces: [
      { kind: 'route', id: 'GET /settings' },
      { kind: 'route', id: 'POST /checkout' },
    ],
  };

  const faithful = {
    surfaces: [
      { kind: 'route', id: 'GET /settings' },
      { kind: 'route', id: 'POST /checkout' },
      // Jobs, tables and externals are the model's own work and are not judged here.
      { kind: 'job', id: 'renew_subscriptions' },
      { kind: 'table', id: 'users' },
    ],
  };
  assert.deepEqual(inventoryProblems(inventory, faithful), []);

  const renamed = { surfaces: [{ kind: 'route', id: 'GET /settings' }, { kind: 'route', id: 'POST /checkout/' }] };
  const problems = inventoryProblems(inventory, renamed);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /missing 1 address the router declared: POST \/checkout\b/);
  assert.match(problems[1], /1 route the router never declared: POST \/checkout\//);

  // A2time's own failure, in one line.
  assert.match(
    inventoryProblems(inventory, {
      surfaces: [{ kind: 'route', id: 'GET /settings' }, { kind: 'route', id: 'POST /checkout' }, { kind: 'route', id: 'GET /work_time' }],
    })[0],
    /never declared: GET \/work_time/,
  );

  // Neither file readable is itself a finding, never a silent pass.
  assert.equal(inventoryProblems(null, faithful).length, 1);
  assert.equal(inventoryProblems(inventory, { surfaces: 'nope' }).length, 1);
});

// Second review round. Holding the ids alone left the rest of the entry free:
// a `source_file` filled in where the inventory had none is an invented fact of
// exactly the kind this spec removes, and a `handler_symbol` swapped for some
// other node that happens to exist passes the host's check while pointing spec
// 35's trace at the wrong code.
test('a copied address must arrive with the fields it left with', () => {
  const inventory = {
    surfaces: [
      { kind: 'route', id: 'GET /settings', source_file: 'app/controllers/settings_controller.rb',
        handler_symbol: 'controllers_settings_controller_settingscontroller_index',
        handler_label: 'settings#index' },
      // A gem's address: the router knows it exists and nothing else is known.
      { kind: 'route', id: 'GET /rails/active_storage/blobs/:signed_id/*filename',
        handler_label: 'active_storage/blobs/redirect#show' },
    ],
  };

  assert.deepEqual(inventoryProblems(inventory, inventory), []);

  const helpful = {
    surfaces: [
      inventory.surfaces[0],
      // Filled in a plausible-looking path for the address that had none.
      { ...inventory.surfaces[1], source_file: 'app/controllers/blobs_controller.rb' },
    ],
  };
  assert.match(
    inventoryProblems(inventory, helpful)[0],
    /points at code.*GET \/rails\/active_storage\/blobs\/:signed_id\/\*filename → source_file/,
  );

  const relinked = {
    surfaces: [
      { ...inventory.surfaces[0], handler_symbol: 'controllers_admin_controller_admincontroller_index' },
      inventory.surfaces[1],
    ],
  };
  assert.match(inventoryProblems(inventory, relinked)[0], /points at code.*GET \/settings → handler_symbol/);

  // A reworded label and a rewritten link are not the same mistake, and the
  // person reading has to fix the right one, so they are two sentences.
  const prettified = {
    surfaces: [
      { ...inventory.surfaces[0], handler_label: 'SettingsController#index' },
      inventory.surfaces[1],
    ],
  };
  const both = inventoryProblems(inventory, prettified);
  assert.equal(both.length, 1);
  assert.match(both[0], /reworded 1 handler_label: GET \/settings → handler_label.*what the router itself printed/);

  const dropped = {
    surfaces: [
      { kind: 'route', id: 'GET /settings', source_file: 'app/controllers/settings_controller.rb' },
      inventory.surfaces[1],
    ],
  };
  const problems = inventoryProblems(inventory, dropped);
  assert.equal(problems.length, 2, 'the lost link and the lost label are reported apart');
  assert.match(problems[0], /points at code.*GET \/settings → handler_symbol/);
  assert.match(problems[1], /reworded 1 handler_label/);
});
