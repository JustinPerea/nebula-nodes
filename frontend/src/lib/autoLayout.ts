/**
 * Dependency-aware graph layout. Assigns each node to a column by its longest
 * dependency depth (topological layering via Kahn's algorithm) and stacks nodes
 * vertically within a column. Replaces the naive "everything in one row" placement
 * used for agent/Create-authored graphs. Pure + unit-tested; cycle-safe.
 *
 * Spacing goes by each node's size, so a tall image card doesn't run into the
 * node under it. A node the canvas hasn't measured counts as DEFAULT_WIDTH x
 * DEFAULT_HEIGHT, which with the default gaps gives the old fixed 360 x 220 steps.
 */

export const DEFAULT_WIDTH = 240;
export const DEFAULT_HEIGHT = 180;

export interface LayoutNode {
  id: string;
  /** The rendered size, when the canvas has measured the node. */
  width?: number;
  height?: number;
}
export interface LayoutEdge {
  source: string;
  target: string;
}
export interface LayoutOptions {
  /** Space between a column's widest node and the next column. */
  gapX?: number;
  /** Space between nodes stacked in a column. */
  gapY?: number;
  x0?: number;
  y0?: number;
}

function extent(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function computeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: LayoutOptions = {},
): Record<string, { x: number; y: number }> {
  const gapX = opts.gapX ?? 120;
  const gapY = opts.gapY ?? 40;
  const x0 = opts.x0 ?? 0;
  const y0 = opts.y0 ?? 0;

  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));

  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target) || e.source === e.target) continue;
    adj.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }

  // Kahn topological pass — assign each node the longest path length from a root.
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const remaining = new Map(indeg);
  const queue = ids.filter((id) => (remaining.get(id) ?? 0) === 0);
  while (queue.length) {
    const u = queue.shift()!;
    for (const v of adj.get(u)!) {
      layer.set(v, Math.max(layer.get(v) ?? 0, (layer.get(u) ?? 0) + 1));
      remaining.set(v, (remaining.get(v) ?? 0) - 1);
      if ((remaining.get(v) ?? 0) === 0) queue.push(v);
    }
  }
  // Nodes left in a cycle keep whatever layer their processed predecessors gave
  // them (>= 0), so they still place sensibly rather than hanging.

  // Group by layer (stable in input order) and assign positions.
  const byLayer = new Map<number, string[]>();
  for (const id of ids) {
    const L = layer.get(id) ?? 0;
    if (!byLayer.has(L)) byLayer.set(L, []);
    byLayer.get(L)!.push(id);
  }

  const sizes = new Map(nodes.map((n) => [n.id, {
    width: extent(n.width, DEFAULT_WIDTH),
    height: extent(n.height, DEFAULT_HEIGHT),
  }]));
  const pos: Record<string, { x: number; y: number }> = {};
  let x = x0;
  for (const L of [...byLayer.keys()].sort((a, b) => a - b)) {
    let y = y0;
    let widest = 0;
    for (const id of byLayer.get(L)!) {
      const size = sizes.get(id)!;
      pos[id] = { x, y };
      y += size.height + gapY;
      widest = Math.max(widest, size.width);
    }
    x += widest + gapX;
  }
  return pos;
}
