import { DROP_GAP } from './boardDrop';
import type { NodeRect } from './nodePlacement';

/**
 * Where new tiles go on the Board view (Justin decided paste, 2026-10-31; GM -
 * Design's #210 rulings): one helper for a paste, Add images and a drop.
 *
 * - A tile never lands on top of another: every tile keeps `DROP_GAP` from
 *   every other, the ones placed before it in the same batch included.
 * - Paste and Add images (`aim: false`) put each tile at the nearest free spot
 *   to the point (the pointer, or the middle of the view) where the whole tile
 *   fits inside the view. When none does, it goes to the nearest free spot
 *   just outside the view (`nearestFreeOutsideView`) and is reported, so the
 *   board can show its edge chip. The view never moves on its own.
 * - A drop (`aim: true`) keeps the first tile where it was aimed when that
 *   overlaps nothing; if it would overlap a tile it slides to the nearest
 *   free spot. Its other files fan out by the free-spot rule.
 *
 * Exact for the nearest spot: the closest point of the free area to the wish
 * is the wish itself, a projection onto one edge, or a corner where two edges
 * meet, and each of those takes its x and its y from the wish, a tile's edge
 * or the view's edge. Candidates come from the tiles nearest the wish (a cap
 * keeps a 300-tile board fast); every candidate is checked against all tiles.
 */

export interface PlaceRequest {
  /** The point the tiles gather around, in board coordinates. */
  at: { x: number; y: number };
  /** Each tile's size, [width, height], in board pixels, in order. */
  sizes: ReadonlyArray<readonly [number, number]>;
  /** Tiles already on the board. */
  occupied: ReadonlyArray<NodeRect>;
  /** The visible board, in board coordinates, or null before it has a size. */
  view: NodeRect | null;
  /** A drop: the first tile keeps its aim unless it would overlap a tile. */
  aim?: boolean;
  gap?: number;
}

export interface Placed {
  /** Top-left corners, in whole board pixels (what `add`'s `at` takes). */
  spots: Array<{ x: number; y: number }>;
  /** Indexes of the tiles that landed outside the view. */
  outside: number[];
}

/** How many nearby tiles give candidate edges. */
const EDGE_SOURCES = 60;

const overlaps = (a: NodeRect, b: NodeRect, gap: number) =>
  a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

const free = (rect: NodeRect, occupied: ReadonlyArray<NodeRect>, gap: number) =>
  occupied.every((other) => !overlaps(rect, other, gap));

/** True when `rect` lies wholly inside `view`. */
export const insideView = (rect: NodeRect, view: NodeRect) =>
  rect.x >= view.x && rect.y >= view.y && rect.x + rect.width <= view.x + view.width && rect.y + rect.height <= view.y + view.height;

function nearestSources(wish: NodeRect, occupied: ReadonlyArray<NodeRect>): ReadonlyArray<NodeRect> {
  if (occupied.length <= EDGE_SOURCES) return occupied;
  const cx = wish.x + wish.width / 2;
  const cy = wish.y + wish.height / 2;
  const far = (r: NodeRect) => Math.hypot(r.x + r.width / 2 - cx, r.y + r.height / 2 - cy);
  return [...occupied].sort((a, b) => far(a) - far(b)).slice(0, EDGE_SOURCES);
}

/** The nearest free top-left to `wish`'s, inside `bounds` when given, or null. */
function nearestFree(wish: NodeRect, occupied: ReadonlyArray<NodeRect>, bounds: NodeRect | null, gap: number): { x: number; y: number } | null {
  const { width: w, height: h } = wish;
  if (bounds && (Math.ceil(bounds.x) + w > Math.floor(bounds.x + bounds.width)
    || Math.ceil(bounds.y) + h > Math.floor(bounds.y + bounds.height))) return null;
  const xs = new Set<number>([wish.x]);
  const ys = new Set<number>([wish.y]);
  for (const o of nearestSources(wish, occupied)) {
    xs.add(o.x + o.width + gap); xs.add(o.x - gap - w);
    ys.add(o.y + o.height + gap); ys.add(o.y - gap - h);
  }
  if (bounds) {
    xs.add(bounds.x); xs.add(bounds.x + bounds.width - w);
    ys.add(bounds.y); ys.add(bounds.y + bounds.height - h);
  }
  // Whole pixels, kept inside the bounds after rounding.
  const clampX = (x: number) => (bounds
    ? Math.min(Math.max(Math.round(x), Math.ceil(bounds.x)), Math.floor(bounds.x + bounds.width - w)) : Math.round(x));
  const clampY = (y: number) => (bounds
    ? Math.min(Math.max(Math.round(y), Math.ceil(bounds.y)), Math.floor(bounds.y + bounds.height - h)) : Math.round(y));
  const candidates: Array<{ x: number; y: number; d: number }> = [];
  for (const rawX of xs) {
    const x = clampX(rawX);
    for (const rawY of ys) {
      const y = clampY(rawY);
      candidates.push({ x, y, d: (x - wish.x) ** 2 + (y - wish.y) ** 2 });
    }
  }
  candidates.sort((a, b) => a.d - b.d);
  for (const spot of candidates) {
    if (free({ x: spot.x, y: spot.y, width: w, height: h }, occupied, gap)) return { x: spot.x, y: spot.y };
  }
  return null;
}

/**
 * No room in the view: the nearest free spot just outside it (GM, #210 answer
 * 1 (a)). Nothing overlaps and the view doesn't move; the board shows its
 * edge chip for it. Always finds one: right of every tile is free.
 */
export function nearestFreeOutsideView(wish: NodeRect, occupied: ReadonlyArray<NodeRect>, gap = DROP_GAP): { x: number; y: number } {
  const found = nearestFree(wish, occupied, null, gap);
  if (found) return found;
  const right = occupied.reduce((edge, o) => Math.max(edge, o.x + o.width), wish.x - gap);
  return { x: Math.ceil(right + gap), y: wish.y };
}

export function placeTiles({ at, sizes, occupied, view, aim = false, gap = DROP_GAP }: PlaceRequest): Placed {
  const taken: NodeRect[] = [...occupied];
  const spots: Array<{ x: number; y: number }> = [];
  const outside: number[] = [];
  sizes.forEach(([w, h], index) => {
    const wish: NodeRect = { x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), width: w, height: h };
    let spot: { x: number; y: number } | null = null;
    if (aim && index === 0 && free(wish, taken, gap)) spot = { x: wish.x, y: wish.y };
    spot ??= view ? nearestFree(wish, taken, view, gap) : nearestFree(wish, taken, null, gap);
    spot ??= nearestFreeOutsideView(wish, taken, gap);
    const rounded = { x: spot.x, y: spot.y };
    const rect = { ...rounded, width: w, height: h };
    if (view && !insideView(rect, view)) outside.push(index);
    taken.push(rect);
    spots.push(rounded);
  });
  return { spots, outside };
}
