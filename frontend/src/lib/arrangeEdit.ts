/**
 * Lay out an agent edit's new nodes once the canvas has measured them.
 *
 * An agent asks for this with `arrange` on a direct edit (POST
 * /api/graph/apply, edit_canvas, `nebula apply`). The backend sends the open
 * requests with every graphSync (`arrange: [{id, nodeIds, direction, gap}]`);
 * ArrangeController waits until those nodes have rendered at their real size,
 * runs this, and writes the result back through PUT /api/graph/layout with
 * the request's id (the first tab to write wins).
 *
 * Only the request's nodes get positions; every other node is an obstacle the
 * block must not land on. The block starts at the top-left of where the
 * agent placed the nodes and moves only if that spot would overlap another
 * node. With `bounds` (the part of the screen no floating bar covers, in
 * flow units), a block that fits there lands inside it: moved in from where
 * it was placed, and clear of other nodes when there is room. Pure and
 * unit-tested.
 */

import { computeLayout, DEFAULT_HEIGHT, DEFAULT_WIDTH, type LayoutEdge } from './autoLayout';

export type ArrangeDirection = 'right' | 'down';

export interface ArrangeRequest {
  id: string;
  nodeIds: string[];
  direction: ArrangeDirection;
  /** Space between columns (rows when direction is down), in canvas pixels. */
  gap: number;
}

export interface PlacedNode {
  id: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
}

/** Space between nodes in the same column (or row), and kept around other nodes. */
export const ARRANGE_STACK_GAP = 40;
const MAX_SHIFTS = 200;

export interface Box { left: number; top: number; right: number; bottom: number }

/** Grid step when looking for a free spot inside `bounds`. */
const BOUNDS_SEARCH_STEP = ARRANGE_STACK_GAP * 2;

function extent(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function boxOf(node: PlacedNode): Box {
  const width = extent(node.width, DEFAULT_WIDTH);
  const height = extent(node.height, DEFAULT_HEIGHT);
  return { left: node.position.x, top: node.position.y, right: node.position.x + width, bottom: node.position.y + height };
}

function overlaps(a: Box, b: Box, margin: number): boolean {
  return a.left < b.right + margin && b.left < a.right + margin
    && a.top < b.bottom + margin && b.top < a.bottom + margin;
}

/**
 * Positions for the request's nodes that are on the canvas, or null when none
 * are. `nodes` is the whole canvas; `edges` may include any wires.
 */
export function arrangeNewNodes(
  request: ArrangeRequest,
  nodes: PlacedNode[],
  edges: LayoutEdge[],
  bounds?: Box,
): Record<string, { x: number; y: number }> | null {
  const wanted = new Set(request.nodeIds);
  const fresh = request.nodeIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is PlacedNode => Boolean(node));
  if (fresh.length === 0) return null;
  const others = nodes.filter((node) => !wanted.has(node.id)).map(boxOf);
  const internal = edges.filter((edge) => wanted.has(edge.source) && wanted.has(edge.target));

  const anchorX = Math.min(...fresh.map((node) => node.position.x));
  const anchorY = Math.min(...fresh.map((node) => node.position.y));
  const gap = Number.isFinite(request.gap) && request.gap >= 0 ? request.gap : 120;
  const down = request.direction === 'down';
  const sized = fresh.map((node) => {
    const width = extent(node.width, DEFAULT_WIDTH);
    const height = extent(node.height, DEFAULT_HEIGHT);
    // computeLayout flows left to right; for "down", lay out on swapped axes and swap back.
    return down ? { id: node.id, width: height, height: width } : { id: node.id, width, height };
  });
  const laid = computeLayout(sized, internal, { gapX: gap, gapY: ARRANGE_STACK_GAP });
  const positions: Record<string, { x: number; y: number }> = {};
  for (const node of fresh) {
    const point = laid[node.id];
    positions[node.id] = down
      ? { x: anchorX + point.y, y: anchorY + point.x }
      : { x: anchorX + point.x, y: anchorY + point.y };
  }

  const boxes = fresh.map((node) => boxOf({ ...node, position: positions[node.id] }));
  const laidOut: Box = {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
  const shifted = (dx: number, dy: number): Box => ({
    left: laidOut.left + dx, top: laidOut.top + dy, right: laidOut.right + dx, bottom: laidOut.bottom + dy,
  });
  const clear = (block: Box) => !others.some((other) => overlaps(block, other, ARRANGE_STACK_GAP));
  const fits = bounds !== undefined
    && laidOut.right - laidOut.left <= bounds.right - bounds.left
    && laidOut.bottom - laidOut.top <= bounds.bottom - bounds.top;

  // Into view first: the nearest spot inside the bounds.
  let dx = fits && bounds ? clampShift(laidOut.left, laidOut.right, bounds.left, bounds.right) : 0;
  let dy = fits && bounds ? clampShift(laidOut.top, laidOut.bottom, bounds.top, bounds.bottom) : 0;
  // Keep clear of every other node: move the whole block right or down,
  // whichever is the shorter way past what it hits.
  for (let step = 0; step < MAX_SHIFTS; step += 1) {
    const block = shifted(dx, dy);
    const hits = others.filter((other) => overlaps(block, other, ARRANGE_STACK_GAP));
    if (hits.length === 0) break;
    const right = Math.max(...hits.map((hit) => hit.right)) + ARRANGE_STACK_GAP - block.left;
    const below = Math.max(...hits.map((hit) => hit.bottom)) + ARRANGE_STACK_GAP - block.top;
    if (below <= right) dy += below;
    else dx += right;
  }
  // Stepping past other nodes can leave the bounds. Then the free spot inside
  // them nearest to where it was placed, if there is one; else the canvas
  // brings the block into view (ArrangeController).
  if (fits && bounds && !inside(shifted(dx, dy), bounds)) {
    const spot = freeSpotInside(laidOut, bounds, clear);
    if (spot) ({ dx, dy } = spot);
  }
  for (const id of Object.keys(positions)) {
    positions[id] = { x: positions[id].x + dx, y: positions[id].y + dy };
  }
  return positions;
}

/** The smallest move that puts [low, high] inside [min, max] (it fits). */
function clampShift(low: number, high: number, min: number, max: number): number {
  if (low < min) return min - low;
  if (high > max) return max - high;
  return 0;
}

export function inside(block: Box, bounds: Box): boolean {
  return block.left >= bounds.left && block.top >= bounds.top
    && block.right <= bounds.right && block.bottom <= bounds.bottom;
}

/** The free spot inside `bounds` closest to `block`, as a move, or null. */
function freeSpotInside(
  block: Box,
  bounds: Box,
  clear: (candidate: Box) => boolean,
): { dx: number; dy: number } | null {
  const width = block.right - block.left;
  const height = block.bottom - block.top;
  let best: { dx: number; dy: number; distance: number } | null = null;
  for (let top = bounds.top; top + height <= bounds.bottom; top += BOUNDS_SEARCH_STEP) {
    for (let left = bounds.left; left + width <= bounds.right; left += BOUNDS_SEARCH_STEP) {
      const candidate = { left, top, right: left + width, bottom: top + height };
      if (!clear(candidate)) continue;
      const distance = Math.hypot(left - block.left, top - block.top);
      if (!best || distance < best.distance) best = { dx: left - block.left, dy: top - block.top, distance };
    }
  }
  return best && { dx: best.dx, dy: best.dy };
}

/** A string that changes when any of these nodes' measured sizes change. */
export function sizeSignature(nodes: PlacedNode[]): string {
  return nodes.map((node) => `${node.id}:${Math.round(node.width ?? -1)}x${Math.round(node.height ?? -1)}`).join('|');
}
