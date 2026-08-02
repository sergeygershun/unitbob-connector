import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runProcess, type ProcResult } from '../proc.ts';
import { firstErrorLine } from '../runner/bootcheck.ts';
import { graphPath } from '../files/mapBuild.ts';

// Spec 32-7. An address is a fact the application declares about itself. The
// router holds every one of them, in machine-readable form, and hands them over
// for the price of one command. Asking the model instead cost 53 KB of output on
// the a2time run and produced `GET /work_time`, an address that is nowhere in
// that project's `config/routes.rb`.
//
// So this module asks the router. It authors nothing: every field below is
// either printed by `rails routes` or copied whole out of `graph.json`, with one
// stated exception — an address whose action has no graph node takes the file
// path Rails' own convention gives it, and only when that file is really on
// disk (see `toSurface`). The rule holds for `handler_label` too, which is the
// router's own
// `settings#index` rather than a class name we spell (`Api::V1::…` is wrong on
// any project with its own inflections, and the whole point of this spec is to
// stop spelling names). What is left for the model — grouping the addresses
// into capabilities and giving them names a vibecoder recognises — is the part
// no command can answer.
//
// Silence is a normal answer, not an error. A stack we cannot ask, an
// application that will not load, output we cannot read: all three end the same
// way, with no file written, and `extract_surfaces` reads the source itself as
// it always has. That fallback is the reason this module is allowed to refuse
// rather than guess.
export type RouteInventory =
  | {
      status: 'written';
      path: string;
      routes: number;
      linked: number;
      environment: RouteEnvironment;
    }
  | { status: 'silent'; reason: SilenceReason; detail?: string };

// `test` first — it is where the guardrail suite boots, so the map describes the
// same application the suite runs against. But `map-prepare` is the first command
// on a fresh checkout, long before the boot check of spec 32-6 provisions a test
// database, and an application that touches the database while booting fails
// there while starting perfectly in its default environment. Reporting that as
// "your application did not load" would send somebody to debug a healthy app, so
// the default environment gets a turn before we say anything of the sort.
export type RouteEnvironment = 'test' | 'default';

export type SilenceReason =
  | 'unsupported_stack'
  | 'router_too_old'
  | 'app_did_not_load'
  | 'did_not_finish'
  | 'no_routes'
  | 'could_not_write';

// One route as the router declares it, shaped as the surfaces.json entry the
// model will copy — same keys, same order, nothing to translate.
export interface RouteSurface {
  kind: 'route';
  id: string;
  source_file?: string;
  handler_symbol?: string;
  handler_label?: string;
}

export interface RouteInventoryDeps {
  runCmd: (
    command: string,
    args: string[],
    options: { cwd: string; env?: Record<string, string> },
  ) => Promise<ProcResult>;
}

// Reading a router means booting the application, which on a large Rails app is
// tens of seconds. The same budget the other boot-shaped step uses.
const ROUTES_TIMEOUT_MS = 120_000;

const defaultDeps: RouteInventoryDeps = {
  runCmd: (command, args, options) =>
    runProcess(command, args, {
      cwd: options.cwd,
      timeoutMs: ROUTES_TIMEOUT_MS,
      env: { ...process.env, ...options.env },
    }),
};

export function routeInventoryPath(projectRoot: string): string {
  return join(projectRoot, '.unitbob', 'map-build', 'route_inventory.json');
}

// Ask this project's router, and write what it says. Rails today; the design
// records why Django, FastAPI and Flask come next and why Express cannot follow
// at all (its addresses are registered by arbitrary code at run time).
export async function extractRouteInventory(
  projectRoot: string,
  deps: RouteInventoryDeps = defaultDeps,
): Promise<RouteInventory> {
  if (!looksLikeRails(projectRoot)) return silent(projectRoot, 'unsupported_stack');

  const asked = await askTheRouter(projectRoot, deps);
  if ('reason' in asked) return silent(projectRoot, asked.reason, asked.detail);

  const rows = parseExpandedRoutes(asked.result.stdout);
  // Zero rows is far likelier to mean "this output is not what we know how to
  // read" than "this application has no addresses". Claiming the second would
  // hand the map a confident, empty answer, so we claim neither.
  if (rows.length === 0) return silent(projectRoot, 'no_routes');

  const nodes = graphNodes(projectRoot);
  const surfaces = rows.map((row) => toSurface(projectRoot, row, nodes));

  // The inventory, and only the inventory. `surfaces.json` is not written here,
  // however tempting: the recipe turns this file into that one with a single
  // command — no output spent retyping addresses, and the file still does not
  // exist until the model has begun. That absence is a check we would otherwise
  // throw away, because `put-map-build` refuses a build whose `surfaces.json` is
  // missing, and a pre-written file full of routes looks finished enough for the
  // job, table and external surfaces never to be looked for.
  const path = routeInventoryPath(projectRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ declared_by: 'rails routes', environment: asked.environment, surfaces }, null, 2)}\n`,
    );
  } catch (err) {
    // A read-only checkout or a full disk is not a reason to take the whole map
    // build down: without an inventory the recipe reads the source, exactly as
    // on every stack we cannot ask.
    return silent(projectRoot, 'could_not_write', (err as Error).message);
  }

  return {
    status: 'written',
    path,
    routes: surfaces.length,
    linked: surfaces.filter((surface) => surface.handler_symbol).length,
    environment: asked.environment,
  };
}

type Asked =
  | { result: ProcResult; environment: RouteEnvironment }
  | { reason: SilenceReason; detail?: string };

// One question, up to two environments. Everything that can be decided from the
// first answer is decided there; only "this environment refused to load" is
// worth asking again, because that is the one failure an environment can own.
async function askTheRouter(projectRoot: string, deps: RouteInventoryDeps): Promise<Asked> {
  const first = await runRailsRoutes(projectRoot, deps, 'test');
  if (first === null) {
    // The command is not on this machine. A second environment cannot conjure it.
    return { reason: 'app_did_not_load', detail: 'the command did not run on this machine' };
  }
  if (first.code === 0) return { result: first, environment: 'test' };

  // Rails learned `--expanded` in 5.1. Older ones reject the flag before they
  // load anything, and saying "your application did not load" there sends
  // somebody to debug an application that is perfectly fine — the same reason
  // the boot check grew `runner_too_old` rather than calling vitest missing.
  // The flag is refused the same way in every environment, so there is nothing
  // to retry.
  if (rejectedTheFlag(first)) return { reason: 'router_too_old' };

  // No exit code at all means the process was stopped rather than finished —
  // our own timeout, or a signal from outside. An application too large to
  // enumerate its routes in the time we allow has told us nothing about whether
  // it is healthy, and "it did not load" would be us inventing the answer.
  // Retrying would spend the same budget twice for the same silence.
  if (first.code === null) return { reason: 'did_not_finish' };

  const second = await runRailsRoutes(projectRoot, deps, 'default');
  if (second !== null && second.code === 0) return { result: second, environment: 'default' };
  if (second !== null && second.code === null) return { reason: 'did_not_finish' };

  // `rails routes` loads the application, so running it *is* the check: an app
  // that will not boot cannot print its routes. We do not ask the boot check
  // from spec 32-6 first — that would boot the app twice to learn the same
  // thing — but we do answer in its currency, quoting the runner's own first
  // error line rather than a paraphrase of it. The default environment's words
  // are the ones quoted: if even that one will not load, the application does
  // not load, and the test database is not what is missing.
  const output = `${second?.stdout ?? first.stdout}\n${second?.stderr ?? first.stderr}`.trim();
  return {
    reason: 'app_did_not_load',
    detail: output ? firstErrorLine(output) : 'the command did not run on this machine',
  };
}

// Every way of saying nothing goes through here, and every one of them takes
// yesterday's inventory with it. Silence must leave no answer behind: a file
// full of the addresses of a previous run sits in the folder the map build
// reads, under an authoritative name, and nothing on it says how old it is.
// `request.json` would not point at it, but a stale answer that looks current
// is the same failure this spec exists to remove — only quieter, because it was
// true once.
function silent(projectRoot: string, reason: SilenceReason, detail?: string): RouteInventory {
  try {
    rmSync(routeInventoryPath(projectRoot), { force: true });
  } catch {
    // Nothing to clear, or a path we cannot touch. Either way the answer below
    // stands: this run declares no addresses.
  }
  return detail === undefined ? { status: 'silent', reason } : { status: 'silent', reason, detail };
}

// The one sentence a vibecoder reads about all this: how many addresses came
// back, or why none did. It lives beside the closed list of reasons rather than
// in the verb, because both the verb and `map-prepare` print it and neither owns
// the vocabulary.
export function describeRouteInventory(result: RouteInventory): string {
  if (result.status === 'written') {
    return (
      `Route inventory written to ${result.path}: ${result.routes} ${plural(result.routes, 'address', 'addresses')} ` +
      `from the router${result.environment === 'default' ? ' (read in the default environment — the test one ' +
        'would not load)' : ''}, ${result.linked} tied to a graph node. The extract_surfaces recipe turns ` +
      'this file into surfaces.json with one command, then adds the job, table and external surfaces to it.'
    );
  }

  return `No route inventory: ${becauseOf(result)}. The extract_surfaces recipe reads the source instead.`;
}

// Why we stayed quiet, in the vibecoder's words. A closed list, so the sentence
// is the same from run to run and a test can pin it.
function becauseOf(result: Extract<RouteInventory, { status: 'silent' }>): string {
  switch (result.reason) {
    case 'unsupported_stack':
      return 'this project has no router Unitbob can ask yet (Rails is the only one so far)';
    case 'router_too_old':
      return '`rails routes --expanded` needs Rails 5.1 or newer, and this Rails refused the flag ' +
        '(nothing is wrong with the application)';
    case 'app_did_not_load':
      return `\`rails routes\` did not get through — ${result.detail}`;
    case 'did_not_finish':
      // No exit code means stopped, and we do not know by whom: our own
      // ${minutes}-minute limit, or something outside this process. Naming only
      // the timeout would put a duration on a run that may have been killed in
      // ten seconds — a claim we cannot make.
      return `\`rails routes\` was stopped before it finished — either it ran past the ` +
        `${ROUTES_TIMEOUT_MS / 60_000}-minute limit or something else killed it (nothing here says the ` +
        'application is unhealthy)';
    case 'no_routes':
      return '`rails routes` printed nothing this version knows how to read';
    case 'could_not_write':
      return `the inventory could not be written — ${result.detail}`;
  }
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function looksLikeRails(projectRoot: string): boolean {
  return existsSync(join(projectRoot, 'config', 'routes.rb'));
}

// `--expanded` rather than the default table: one field per line, so nothing
// depends on guessing column widths, and a long URI pattern cannot run into its
// neighbour. `test` is asked first because that is the environment the guardrail
// suite boots in, so the routes read there are the routes the suite would see;
// `default` means we leave RAILS_ENV alone and take whatever the project's own
// setup chooses.
async function runRailsRoutes(
  projectRoot: string,
  deps: RouteInventoryDeps,
  environment: RouteEnvironment,
): Promise<ProcResult | null> {
  const local = join(projectRoot, 'bin', 'rails');
  const [command, args] = existsSync(local)
    ? [local, ['routes', '--expanded']]
    : ['bundle', ['exec', 'rails', 'routes', '--expanded']];

  try {
    return await deps.runCmd(command, args, {
      cwd: projectRoot,
      env: environment === 'test'
        ? { RAILS_ENV: 'test', UNITBOB_REPO_ROOT: projectRoot }
        : { UNITBOB_REPO_ROOT: projectRoot },
    });
  } catch {
    return null; // the command is not on this machine
  }
}

// Ruby's own OptionParser wording, and Thor's — whichever layer of the `rails`
// command line sees the flag first. Both name the flag they refused, and the
// name has to be part of the match: "invalid option" is ordinary Ruby wording
// that also turns up inside a failing initializer, and reading that as an old
// Rails would tell somebody their application is fine while it is broken —
// exactly the wrong-errand this reason exists to prevent, pointing the other way.
function rejectedTheFlag(result: ProcResult): boolean {
  return /(?:invalid option|unknown switches?|unrecognized option)[^\n]*expanded/i.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

interface RouteRow {
  verb: string;
  path: string;
  controller?: string;
  action?: string;
}

// The `--expanded` record:
//
//   --[ Route 1 ]------------------------------
//   Prefix            | settings
//   Verb              | GET
//   URI               | /settings(.:format)
//   Controller#Action | settings#index
//
// The path field is `URI` on Rails 7 and `URI Pattern` on older versions — both
// are read, because which one we get is decided by the user's Gemfile. Fields we
// do not use (Prefix, Source Location) are ignored rather than rejected, so a
// newer Rails printing more of them still reads.
export function parseExpandedRoutes(stdout: string): RouteRow[] {
  const rows: RouteRow[] = [];
  const seen = new Set<string>();
  let record: Record<string, string> = {};

  const flush = (): void => {
    for (const row of rowsFrom(record)) {
      const key = `${row.verb} ${row.path}`;
      // The same address can be drawn under several prefixes. It is one address.
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    record = {};
  };

  for (const line of stdout.split('\n')) {
    if (/^--\[ Route /.test(line)) {
      flush();
      continue;
    }
    const separator = line.indexOf('|');
    if (separator === -1) continue;
    record[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  flush();

  return rows;
}

function rowsFrom(record: Record<string, string>): RouteRow[] {
  const pattern = record.URI ?? record['URI Pattern'];
  const verb = record.Verb ?? '';
  // No verb means a mounted Rack application (`mount Sidekiq::Web at: '/sidekiq'`),
  // not an address of this application. Its own routes live in its own router.
  if (!pattern || !verb) return [];

  const handler = /^([A-Za-z0-9_/]+)#([A-Za-z0-9_]+)$/.exec(record['Controller#Action'] ?? '');
  const path = pattern.replace(/\(\.:format\)$/, '');

  // `match via: [:get, :post]` prints one record with both verbs. They are two
  // addresses, and the map should say so.
  return verb.split('|').map((one) => ({
    verb: one.trim(),
    path,
    controller: handler?.[1],
    action: handler?.[2],
  }));
}

interface GraphNode {
  id: string;
  label?: string;
  source_file?: string;
}

function graphNodes(projectRoot: string): GraphNode[] {
  const path = graphPath(projectRoot);
  if (!existsSync(path)) return [];

  try {
    const graph = JSON.parse(readFileSync(path, 'utf8')) as { nodes?: unknown };
    if (!Array.isArray(graph.nodes)) return [];
    return graph.nodes.filter(
      (node): node is GraphNode => !!node && typeof (node as GraphNode).id === 'string',
    );
  } catch {
    return []; // an unreadable graph costs us the links, not the addresses
  }
}

function toSurface(projectRoot: string, row: RouteRow, nodes: GraphNode[]): RouteSurface {
  const surface: RouteSurface = { kind: 'route', id: `${row.verb} ${row.path}` };
  if (!row.controller || !row.action) return surface;

  const file = join('app', 'controllers', `${row.controller}_controller.rb`);
  const node = findNode(nodes, file, row.action);

  // The node's own path when we found it; otherwise the file the convention
  // names, and only if it is really there — a route from a gem has neither.
  //
  // This second branch is the one place the module answers with something the
  // router did not print, so it is worth being plain about what it claims and
  // what it does not. It claims: Rails resolves `settings#index` to
  // `app/controllers/settings_controller.rb`, and that file exists here. It does
  // not claim the method lives in that file — an inherited action's controller
  // is on disk while the code that serves it is in a parent class elsewhere.
  // That is why the same branch leaves `handler_symbol` out: the file is where
  // Rails looks, the link is where the code is, and only the second one is
  // allowed to be a guess-free fact.
  if (node?.source_file) surface.source_file = node.source_file;
  else if (existsSync(join(projectRoot, file))) surface.source_file = file;

  if (node) surface.handler_symbol = node.id;
  // What the router printed, not a class name we built from it.
  surface.handler_label = `${row.controller}#${row.action}`;
  return surface;
}

// The link is *searched for*, never spelled. graphify names its node ids by an
// internal rule, it is a third-party package (`pip install graphifyy`), and that
// rule may change in any release. Rebuilding the rule here would make us
// responsible for somebody else's private detail and would break in a way we
// could not see. So we look the node up by the two things the router already
// knows — which file, which method — and copy the id it carries, whole.
//
// Not finding one is ordinary: the action may be drawn by a template with no
// method behind it, inherited from a parent class in another file, or come from
// a gem graphify never saw. Then the address keeps its place with no link. The
// router said it exists, so it exists; an empty field says "we do not know
// where this is served", while dropping the address would say it is not there
// at all.
// A wrong link is worse than no link — the address would send a later trace
// into somebody else's code, and nothing downstream could tell: the node it
// names really does exist, so the host's check passes. Hence the ranking below
// rather than "first node that fits".
function findNode(nodes: GraphNode[], file: string, action: string): GraphNode | undefined {
  const candidates = nodes.filter(
    (node) =>
      typeof node.source_file === 'string' &&
      typeof node.label === 'string' &&
      methodNameOf(node.label) === action &&
      pathsMatch(node.source_file, file) !== 'no',
  );

  // The path the graph gives may be relative to the project or absolute, so an
  // exact match cannot be the only rule. But when one node names exactly the
  // file the router pointed at, it wins outright: an engine, a second app in
  // the monorepo or a vendored copy can end with the same
  // `app/controllers/users_controller.rb` and would otherwise be picked by
  // nothing better than graph order.
  //
  // One, though — not "the first of several". Two nodes can name the same file
  // and the same method: two classes in one file, or a graph that lists a
  // definition more than once. Taking the earlier one there is the very rule
  // this branch was written to replace, one level down, so the same answer
  // applies as below: we do not know, and we say so by staying quiet.
  const exact = candidates.filter((node) => pathsMatch(node.source_file as string, file) === 'exact');
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;

  // Ends with the right path and is the only one that does. Two or more and we
  // cannot tell which file the router meant, so we say nothing — the address
  // still ships, without a link.
  return candidates.length === 1 ? candidates[0] : undefined;
}

function pathsMatch(candidate: string, file: string): 'exact' | 'suffix' | 'no' {
  const normalised = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
  const wanted = file.replace(/\\/g, '/');
  if (normalised === wanted) return 'exact';
  return normalised.endsWith(`/${wanted}`) ? 'suffix' : 'no';
}

// Real graphify labels a Ruby method `.send_to_fsa()` and a JS one
// `initButtons()`; a qualified `CheckoutController#create` also turns up. All of
// them are read the same way — drop the call parentheses, then take the last
// name — so the match survives the decoration without depending on which form
// this release of graphify happens to use. The id itself is never rebuilt from
// any of this; it is copied.
function methodNameOf(label: string): string {
  const parts = label.replace(/\(.*\)\s*$/, '').split(/::|[#./]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

// What `surfaces.json` must contain for every address the router declared, and
// what it must not contain on top of them. Used before upload (`put-map-build`):
// the inventory removed the model's chance to invent an address, and this
// removes its chance to lose or rename one on the way to the map. The same move
// spec 32-6 made for suites — check the answer against the request locally,
// while both files are still on this machine.
//
// Routes only. Whether the grouping is sensible, whether the human names are
// good, what the jobs and tables are — none of that is this function's business.
export function inventoryProblems(inventory: unknown, surfaces: unknown): string[] {
  const declared = routeEntriesIn(inventory);
  if (declared === null) {
    return ['the route inventory is not readable, so what the router declared cannot be confirmed'];
  }

  const written = routeEntriesIn(surfaces);
  if (written === null) return ['surfaces.json has no readable `surfaces` array'];

  const problems: string[] = [];
  const missing = [...declared.keys()].filter((id) => !written.has(id));
  const invented = [...written.keys()].filter((id) => !declared.has(id));

  if (missing.length > 0) {
    problems.push(
      `surfaces.json is missing ${missing.length} address the router declared: ${list(missing)}. ` +
        'Copy every entry of the route inventory across unchanged.',
    );
  }
  if (invented.length > 0) {
    problems.push(
      `surfaces.json carries ${invented.length} route the router never declared: ${list(invented)}. ` +
        'The router is the authority on what exists; an address it does not know is either a typo ' +
        'in a copied id or invented.',
    );
  }

  // Two sentences rather than one, because the two kinds of rewrite are not the
  // same mistake and the person reading has to fix the right thing: one sends a
  // later trace into the wrong code, the other only renames what is shown.
  const relinked = alteredFields(declared, written, LINK_FIELDS);
  if (relinked.length > 0) {
    problems.push(
      `surfaces.json rewrote ${relinked.length} field that points at code: ${list(relinked)}. ` +
        'Copy each entry as it stands — a field the inventory leaves out is an answer too, ' +
        '"we do not know where this is served", and filling it in makes one up.',
    );
  }

  const relabelled = alteredFields(declared, written, LABEL_FIELDS);
  if (relabelled.length > 0) {
    problems.push(
      `surfaces.json reworded ${relabelled.length} handler_label: ${list(relabelled)}. ` +
        'That name is what the router itself printed; the human names for the map are the ' +
        'capability titles in the next step, not this field.',
    );
  }
  return problems;
}

// The id says the address exists; these say where it is served, and both were
// either printed by the router or copied out of the graph. A blank is not a gap
// to be helpfully filled — an invented `source_file` is the same failure as an
// invented address, one field over, and a `handler_symbol` swapped for another
// node that happens to exist passes the host's check while sending spec 35's
// trace into the wrong code.
const LINK_FIELDS = ['source_file', 'handler_symbol'] as const;

// Not a link and nothing downstream reads it — but spec 32-7 took the authoring
// of names away from the model on purpose, and `settings#index` as the router
// printed it is the whole of what we claim. A prettier `Api::V1::UsersController`
// is simply wrong on a project with its own inflections.
const LABEL_FIELDS = ['handler_label'] as const;

function alteredFields(
  declared: Map<string, RouteEntry>,
  written: Map<string, RouteEntry>,
  fields: readonly CopiedField[],
): string[] {
  const altered: string[] = [];
  for (const [id, entry] of declared) {
    const copy = written.get(id);
    if (!copy) continue; // already reported as missing
    for (const field of fields) {
      if (entry[field] !== copy[field]) altered.push(`${id} → ${field}`);
    }
  }
  return altered;
}

type CopiedField = (typeof LINK_FIELDS)[number] | (typeof LABEL_FIELDS)[number];

type RouteEntry = Partial<Record<CopiedField, unknown>>;

function routeEntriesIn(document: unknown): Map<string, RouteEntry> | null {
  const surfaces = (document as { surfaces?: unknown } | null)?.surfaces;
  if (!Array.isArray(surfaces)) return null;

  const entries = new Map<string, RouteEntry>();
  for (const surface of surfaces) {
    if (!surface || (surface as { kind?: unknown }).kind !== 'route') continue;
    const id = (surface as { id?: unknown }).id;
    if (typeof id !== 'string' || entries.has(id)) continue;
    entries.set(id, surface as RouteEntry);
  }
  return entries;
}

// Enough ids to recognise the mistake, not so many that the message scrolls off.
function list(ids: string[]): string {
  const shown = ids.slice(0, 10);
  return ids.length > shown.length ? `${shown.join(', ')}, … (+${ids.length - shown.length})` : shown.join(', ');
}
