import { existsSync, readFileSync } from 'node:fs';
import { graphPath } from '../files/mapBuild.ts';

// What `graphify-out/graph.json` says about where code lives, and the three
// small rules for reading it. These were private to `routeInventory.ts` until
// spec 37-1 gave them a second reader (`files/packets.ts`); two copies of a
// matching rule that must agree is the failure this move avoids.
export interface GraphNode {
  id: string;
  label?: string;
  source_file?: string;
}

export function graphNodes(projectRoot: string): GraphNode[] {
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

export function pathsMatch(candidate: string, file: string): 'exact' | 'suffix' | 'no' {
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
export function methodNameOf(label: string): string {
  const parts = label.replace(/\(.*\)\s*$/, '').split(/::|[#./]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}
