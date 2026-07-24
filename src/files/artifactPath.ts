import { isAbsolute } from 'node:path';

// The one rule for whether a host-provided suite file path is safe to write:
// relative, anchored under the given `.unitbob/<kind>/` root, no traversal.
// Both contract systems (spec 32) share it — structural under
// `.unitbob/structural/`, behavioral under `.unitbob/behavioral/`. It mirrors
// the Rails-side check exactly (any `.`/`..` segment is refused outright, not
// resolved), so a path the brain would refuse can never materialize here.
export function assertUnitbobPath(path: string, root: string): void {
  // The root may arrive with or without a trailing slash (the wire's path_root
  // carries one, the local constants do not) — normalize to exactly one.
  const prefix = `${root.replace(/\/+$/, '')}/`;
  const unsafe =
    !path ||
    isAbsolute(path) ||
    !path.startsWith(prefix) ||
    path.split('/').some((segment) => segment === '.' || segment === '..');
  if (unsafe) {
    throw new Error(`suite file path must be a relative path under ${prefix} with no traversal (got "${path}").`);
  }
}
