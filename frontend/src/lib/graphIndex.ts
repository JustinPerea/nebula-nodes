import type { Edge, Node } from '@xyflow/react';

/**
 * Lookups over the graph store's `nodes` and `edges` arrays, built once per
 * array and shared by every caller.
 *
 * Each canvas card subscribes to the few things it draws from the rest of the
 * graph (its wires, a wired source's preview) with a selector that runs on
 * every store change. Scanning the arrays there made each change cost
 * cards x (nodes + edges); with these, a change builds one index and each
 * card's selector is a map lookup. The store replaces an array whenever it
 * changes one of its items, so caching by array identity is exact.
 */

const NO_EDGES: readonly Edge[] = Object.freeze([]);

interface EdgeIndex {
  into: Map<string, Edge[]>;
  out: Map<string, Edge[]>;
}

const nodeIndexes = new WeakMap<readonly Node[], Map<string, Node>>();
const edgeIndexes = new WeakMap<readonly Edge[], EdgeIndex>();

function nodeIndex(nodes: readonly Node[]): Map<string, Node> {
  let index = nodeIndexes.get(nodes);
  if (!index) {
    index = new Map(nodes.map((node) => [node.id, node]));
    nodeIndexes.set(nodes, index);
  }
  return index;
}

function edgeIndex(edges: readonly Edge[]): EdgeIndex {
  let index = edgeIndexes.get(edges);
  if (!index) {
    index = { into: new Map(), out: new Map() };
    for (const edge of edges) {
      const into = index.into.get(edge.target);
      if (into) into.push(edge); else index.into.set(edge.target, [edge]);
      const out = index.out.get(edge.source);
      if (out) out.push(edge); else index.out.set(edge.source, [edge]);
    }
    edgeIndexes.set(edges, index);
  }
  return index;
}

/** The node with this id, or undefined. */
export function nodeById<N extends Node>(nodes: readonly N[], id: string): N | undefined {
  return nodeIndex(nodes).get(id) as N | undefined;
}

/** The edges into a node, in the store's order. Read-only: shared by every caller. */
export function edgesInto(edges: readonly Edge[], nodeId: string): readonly Edge[] {
  return edgeIndex(edges).into.get(nodeId) ?? NO_EDGES;
}

/** The edges out of a node, in the store's order. Read-only: shared by every caller. */
export function edgesOutOf(edges: readonly Edge[], nodeId: string): readonly Edge[] {
  return edgeIndex(edges).out.get(nodeId) ?? NO_EDGES;
}
