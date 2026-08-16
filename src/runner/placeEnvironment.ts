// An installed environment belongs to the place that installed it (spec 36, §6).
//
// The invariant "files on the host, processes where the dependencies live" is
// true of text and false of installed packages. `.unitbob/runners/.venv` and
// `.unitbob/behavioral/node_modules` sit under the project, which is to say
// inside the mounted folder, which is to say both sides can see them — and they
// were built for one operating system. A virtualenv built on macOS is not a
// virtualenv inside a Linux container, however plainly it is there.
//
// And the connector cannot tell by looking: readiness is decided by a file being
// on disk (`provision.ts`, `existsSync(venvPython)`), never by starting it. So
// the main scenario of this whole spec ends badly without the mark below —
// somebody hits the wall on this machine (a `.venv` gets created), reads the
// hint, adds `exec`, runs again, and inside the container the macOS interpreter
// is taken for a finished environment. What follows is `pip` failing to start,
// its stderr discarded, and the advice to run a command that cannot run either.
//
// The cure is one mark, not a directory scheme per place: cheap to write, and
// nothing else in the tree has to know about it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNNER_ENVIRONMENT_ENTRIES } from '../files/behavioral.ts';
import { placeId, placeOf } from './place.ts';
import { SIDECAR_DIR } from './toolchain.ts';

const PLACE_FILE = '.unitbob/.place';
const BEHAVIORAL_DIR = '.unitbob/behavioral';

// Throw away any runner environment that was built somewhere else, and record
// where this one is being built. Returns a line worth printing when something
// was actually removed, and null when nothing was.
//
// Called where an environment can be built again — `suite-prepare` — and
// nowhere else. Clearing it anywhere else would leave a run with no runner and
// no way to get one.
export function alignRunnerEnvironmentWithPlace(projectRoot: string): string | null {
  const current = placeId(placeOf(projectRoot));
  const marked = readMark(projectRoot);

  if (marked === current) return null;

  // A project that has never been marked was provisioned before this existed,
  // which means it was provisioned on this machine. Saying so out loud is what
  // makes "the mark is missing" a fact rather than a mystery.
  const previous = marked ?? 'local';
  const removed = previous === current ? [] : removeRunnerEnvironment(projectRoot);
  writeMark(projectRoot, current);

  if (removed.length === 0) return null;

  return (
    `The test runner installed under \`.unitbob/\` was built for ${describe(previous)}, and this run happens ` +
    `${describe(current)}. An installed package is not portable between the two, so it was removed and will ` +
    `be installed again here (${removed.join(', ')}). Your generated suite was not touched.`
  );
}

function describe(id: string): string {
  return id === 'local' ? 'this machine' : `the container \`${id.slice('docker:'.length)}\``;
}

function readMark(projectRoot: string): string | null {
  try {
    const mark = readFileSync(join(projectRoot, PLACE_FILE), 'utf8').trim();
    return mark.length > 0 ? mark : null;
  } catch {
    return null;
  }
}

function writeMark(projectRoot: string, id: string): void {
  mkdirSync(join(projectRoot, '.unitbob'), { recursive: true });
  writeFileSync(join(projectRoot, PLACE_FILE), `${id}\n`);
}

// The structural sidecar whole, and from the behavioral root only the entries
// that are an installed environment. That list already exists and already means
// exactly "this was installed, it is not generated text", so the suite the host
// wrote survives.
function removeRunnerEnvironment(projectRoot: string): string[] {
  const removed: string[] = [];

  const sidecar = join(projectRoot, SIDECAR_DIR);
  if (existsSync(sidecar)) {
    rmSync(sidecar, { recursive: true, force: true });
    removed.push(`${SIDECAR_DIR}/`);
  }

  for (const entry of new Set(Object.values(RUNNER_ENVIRONMENT_ENTRIES).flatMap((set) => [...set]))) {
    const path = join(projectRoot, BEHAVIORAL_DIR, entry);
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(`${BEHAVIORAL_DIR}/${entry}`);
  }

  return removed.sort();
}
