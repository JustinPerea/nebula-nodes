/**
 * Dependency-aware graph layout. Assigns each node to a column by its longest
 * dependency depth (topological layering via Kahn's algorithm) and spreads nodes
 * vertically within a column. Replaces the naive "everything in one row" placement
 * used for agent/Create-authored graphs. Pure + unit-tested; cycle-safe.
 */

export interface LayoutNode {
  id: string;
}
export interface LayoutEdge {
  source: string;
  target: string;
}
export interface LayoutOptions {
  colGap?: number;
  rowGap?: number;
  x0?: number;
  y0?: number;
}

export function computeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: LayoutOptions = {},
): Record<string, { x: number; y: number }> {
  const colGap = opts.colGap ?? 360;
  const rowGap = opts.rowGap ?? 220;
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

  const pos: Record<string, { x: number; y: number }> = {};
  for (const [L, members] of byLayer) {
    members.forEach((id, i) => {
      pos[id] = { x: x0 + L * colGap, y: y0 + i * rowGap };
    });
  }
  return pos;
}
