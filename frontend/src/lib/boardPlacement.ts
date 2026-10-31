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
 *   anywhere (`nearestFreeAnywhere`, just past the view's edge) and is
 *   reported, so the board can show its edge chip. The view never moves on
 *   its own.
 * - A drop (`aim: true`) keeps the first tile where it was aimed when that
 *   overlaps nothing; if it would overlap a tile it takes the nearest free
 *   spot, even one partly past the view (GM r4 answer 4). That tile is
 *   reported only when it is wholly out of view (GM r4 answers 3 and 4). Its
 *   other files fan out by the free-spot rule.
 *
 * Exact, on any board size (review 2, M1). A tile's top-left may not sit in
 * the open rectangle each other tile rules out (its own box grown by the gap
 * and the new tile's size). The nearest allowed point to the wish has its y
 * on the wish's row or a rectangle's top or bottom (clamped into the view),
 * and on that row its x is the wish's own or the side of the ruled-out span
 * the wish falls in. Rows are tried nearest first and the search stops once a
 * row is farther than the best spot found, so only the rectangles over the
 * rows it reaches are read. The view's own edges need no rows of their own:
 * when the bound is what stops the point, the wish lies past it, and the
 * clamped wish is that edge.
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
  /** Counts the rows and spans the search read (the speed bound's test). */
  work?: PlacementWork;
}

export interface PlacementWork {
  /** Rows tried plus ruled-out spans read on them. */
  cells: number;
}

export interface Placed {
  /** Top-left corners, in whole board pixels (what `add`'s `at` takes). */
  spots: Array<{ x: number; y: number }>;
  /** Indexes of the tiles the board shows its edge chip for. */
  outside: number[];
}

/** True when `rect` lies wholly inside `view`. */
export const insideView = (rect: NodeRect, view: NodeRect) =>
  rect.x >= view.x && rect.y >= view.y && rect.x + rect.width <= view.x + view.width && rect.y + rect.height <= view.y + view.height;

/** True when `rect` and `view` share no area. */
const whollyOutside = (rect: NodeRect, view: NodeRect) =>
  rect.x >= view.x + view.width || rect.x + rect.width <= view.x || rect.y >= view.y + view.height || rect.y + rect.height <= view.y;

const overlaps = (a: NodeRect, b: NodeRect, gap: number) =>
  a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

const free = (rect: NodeRect, occupied: ReadonlyArray<NodeRect>, gap: number) =>
  occupied.every((other) => !overlaps(rect, other, gap));

interface Range { lo: number; hi: number }

/** The top-lefts one tile rules out for the new one, as whole pixels: x0 < x < x1 and y0 < y < y1. */
interface Block { x0: number; x1: number; y0: number; y1: number }

/** The first index in `blocks` (sorted by y0) whose y0 is at least `limit`. */
function firstFrom(blocks: readonly Block[], limit: number): number {
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (blocks[mid].y0 < limit) low = mid + 1; else high = mid;
  }
  return low;
}

/** The tie rule: the wish's own column first, then lower, then to the right. */
function better(x: number, y: number, than: { x: number; y: number }, wishX: number) {
  const own = x === wishX;
  const theirs = than.x === wishX;
  if (own !== theirs) return own;
  if (y !== than.y) return y > than.y;
  return x > than.x;
}

/** The nearest free top-left to `wish`'s, inside `bounds` when given, or null. */
function nearestFree(wish: NodeRect, occupied: ReadonlyArray<NodeRect>, bounds: NodeRect | null, gap: number,
  work?: PlacementWork): { x: number; y: number } | null {
  const { width: w, height: h } = wish;
  const xr: Range = bounds ? { lo: Math.ceil(bounds.x), hi: Math.floor(bounds.x + bounds.width - w) } : { lo: -Infinity, hi: Infinity };
  const yr: Range = bounds ? { lo: Math.ceil(bounds.y), hi: Math.floor(bounds.y + bounds.height - h) } : { lo: -Infinity, hi: Infinity };
  if (xr.lo > xr.hi || yr.lo > yr.hi) return null;
  const clampX = (x: number) => Math.min(Math.max(x, xr.lo), xr.hi);
  const clampY = (y: number) => Math.min(Math.max(y, yr.lo), yr.hi);
  // Whole pixels: a top-left x is ruled out exactly when floor(x0) < x < ceil(x1).
  const blocks: Block[] = occupied.map((o) => ({
    x0: Math.floor(o.x - gap - w), x1: Math.ceil(o.x + o.width + gap),
    y0: Math.floor(o.y - gap - h), y1: Math.ceil(o.y + o.height + gap),
  })).sort((a, b) => a.y0 - b.y0);
  const tallest = blocks.reduce((most, b) => Math.max(most, b.y1 - b.y0), 0);
  const ys = new Set<number>([clampY(wish.y)]);
  for (const b of blocks) { ys.add(clampY(b.y0)); ys.add(clampY(b.y1)); }
  // Rows nearest the wish first: once a row is farther than the best spot,
  // none after can beat it (rows as near are still read; `better` breaks ties).
  const rows = [...ys].sort((a, b) => Math.abs(a - wish.y) - Math.abs(b - wish.y));
  const wishX = clampX(wish.x);
  const found: { best: { x: number; y: number; d: number } | null } = { best: null };
  const consider = (x: number, y: number) => {
    const d = (x - wish.x) ** 2 + (y - wish.y) ** 2;
    const best = found.best;
    if (!best || d < best.d || (d === best.d && better(x, y, best, wishX))) found.best = { x, y, d };
  };
  for (const y of rows) {
    if (found.best && (y - wish.y) ** 2 > found.best.d) break;
    // The blocks over this row: their y0 is below y and within the tallest block of it.
    const spans: Array<[number, number]> = [];
    for (let i = firstFrom(blocks, y - tallest); i < blocks.length && blocks[i].y0 < y; i += 1) {
      const b = blocks[i];
      if (b.y1 > y && b.x1 - b.x0 > 1) spans.push([b.x0, b.x1]);
    }
    if (work) work.cells += spans.length + 1;
    spans.sort((a, b) => a[0] - b[0]);
    // The ruled-out spans merged (open spans meeting at a point leave it free),
    // then the free x nearest the wish: the wish's own, or either side of its span.
    let lo = -Infinity;
    let hi = -Infinity;
    let placed = false;
    const tryAround = (a: number, b: number) => {
      if (wishX <= a || wishX >= b) return false;
      if (a >= xr.lo) consider(a, y);
      if (b <= xr.hi) consider(b, y);
      return true;
    };
    for (const [a, b] of spans) {
      if (a < hi) { hi = Math.max(hi, b); continue; }
      if (hi > lo && tryAround(lo, hi)) { placed = true; break; }
      lo = a;
      hi = b;
    }
    if (!placed && !(hi > lo && tryAround(lo, hi))) consider(wishX, y);
  }
  return found.best ? { x: found.best.x, y: found.best.y } : null;
}

/**
 * The nearest free spot with no view to stay in: used when the view has no
 * room (GM, #210 answer 1 (a)), and for a drop's nudge (GM r4 answer 4), so
 * it may sit partly in the view. Always finds one: right of every tile is free.
 */
export function nearestFreeAnywhere(wish: NodeRect, occupied: ReadonlyArray<NodeRect>, gap = DROP_GAP,
  work?: PlacementWork): { x: number; y: number } {
  const found = nearestFree(wish, occupied, null, gap, work);
  // Unreachable: the column right of every block is in the grid and free.
  if (!found) throw new Error('boardPlacement: no free spot');
  return found;
}

export function placeTiles({ at, sizes, occupied, view, aim = false, gap = DROP_GAP, work }: PlaceRequest): Placed {
  const taken: NodeRect[] = [...occupied];
  const spots: Array<{ x: number; y: number }> = [];
  const outside: number[] = [];
  sizes.forEach(([w, h], index) => {
    const wish: NodeRect = { x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), width: w, height: h };
    const aimed = aim && index === 0;
    let spot: { x: number; y: number } | null = null;
    if (aimed) spot = free(wish, taken, gap) ? { x: wish.x, y: wish.y } : nearestFreeAnywhere(wish, taken, gap, work);
    else if (view) spot = nearestFree(wish, taken, view, gap, work);
    spot ??= nearestFreeAnywhere(wish, taken, gap, work);
    const rect = { x: spot.x, y: spot.y, width: w, height: h };
    if (view && (aimed ? whollyOutside(rect, view) : !insideView(rect, view))) outside.push(index);
    taken.push(rect);
    spots.push({ x: spot.x, y: spot.y });
  });
  return { spots, outside };
}
