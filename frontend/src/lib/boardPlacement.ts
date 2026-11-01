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
  /** Rows tried plus every block read while trying them. */
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

/** True when `rect` keeps the gap from every occupied tile (a held spot, checked again when it fills). */
export const spotFree = (rect: NodeRect, occupied: ReadonlyArray<NodeRect>, gap = DROP_GAP) => free(rect, occupied, gap);

interface Range { lo: number; hi: number }

/** The top-lefts one tile rules out for the new one, as whole pixels: x0 < x < x1 and y0 < y < y1. */
interface Block { x0: number; x1: number; y0: number; y1: number }

/** A block spread over more cells than this is kept in one list read by every query. */
const BIG_BLOCK_CELLS = 64;

/** One cell's blocks, sorted both ways the run walks: by left edge, and by
 *  right edge from the right; and the widest of them, which bounds how far
 *  back a block over a point can start. */
interface Cell { byX0: Block[]; byX1: Block[]; widest: number }

/** The first index in `list` for which `before` is false (`before` holds for a prefix). */
function firstNot(list: readonly Block[], before: (b: Block) => boolean): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (before(list[mid])) low = mid + 1; else high = mid;
  }
  return low;
}

/**
 * The blocks, filed in a grid of cells (review 3, LOW-1): each block in every
 * cell it rules out a point of, so the blocks over a point are all in that
 * point's cell (plus the few too big to file). Cells are a few blocks wide
 * and a quarter of one tall, so a row reads about the blocks on it, and a
 * tall tile or a long band costs nothing on the rows and columns it doesn't
 * touch.
 */
class BlockGrid {
  private readonly cells = new Map<number, Cell>();
  private readonly big: Block[] = [];
  private readonly ox: number;
  private readonly oy: number;
  private readonly cw: number;
  private readonly ch: number;
  private readonly cols: number;
  private readonly work?: PlacementWork;
  /** The rows the search tries: every block's top and bottom edge. */
  readonly edges: number[] = [];

  constructor(blocks: readonly Block[], work?: PlacementWork) {
    this.work = work;
    // Only blocks that rule out a point count (a span of one pixel or less leaves every point free).
    const live = blocks.filter((b) => b.x1 - b.x0 > 1 && b.y1 - b.y0 > 1);
    const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1] ?? 1;
    this.cw = Math.max(1, 4 * median(live.map((b) => b.x1 - b.x0)));
    this.ch = Math.max(1, Math.round(median(live.map((b) => b.y1 - b.y0)) / 4));
    this.ox = live.reduce((least, b) => Math.min(least, b.x0 + 1), 0);
    this.oy = live.reduce((least, b) => Math.min(least, b.y0 + 1), 0);
    const right = live.reduce((most, b) => Math.max(most, b.x1 - 1), 0);
    this.cols = this.col(right) + 1;
    for (const b of live) {
      this.edges.push(b.y0, b.y1);
      const cx0 = this.col(b.x0 + 1);
      const cx1 = this.col(b.x1 - 1);
      const cy0 = this.row(b.y0 + 1);
      const cy1 = this.row(b.y1 - 1);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > BIG_BLOCK_CELLS) { this.big.push(b); continue; }
      for (let cy = cy0; cy <= cy1; cy += 1) for (let cx = cx0; cx <= cx1; cx += 1) {
        const key = cy * this.cols + cx;
        const cell = this.cells.get(key);
        if (cell) cell.byX0.push(b); else this.cells.set(key, { byX0: [b], byX1: [], widest: 0 });
      }
    }
    for (const cell of this.cells.values()) {
      cell.byX0.sort((a, b) => a.x0 - b.x0);
      cell.byX1 = [...cell.byX0].sort((a, b) => b.x1 - a.x1);
      cell.widest = cell.byX0.reduce((most, b) => Math.max(most, b.x1 - b.x0), 0);
    }
  }

  private col(x: number) { return Math.floor((x - this.ox) / this.cw); }

  private row(y: number) { return Math.floor((y - this.oy) / this.ch); }

  private cellAt(x: number, y: number): Cell | undefined {
    const cx = this.col(x);
    return cx >= 0 && cx < this.cols ? this.cells.get(this.row(y) * this.cols + cx) : undefined;
  }

  /** The big blocks over (x, y) on row y, pushing `x` out in `dir` until none covers it. */
  private bigOut(x: number, y: number, dir: 1 | -1): number {
    for (let moved = true; moved;) {
      moved = false;
      for (const b of this.big) {
        if (this.work) this.work.cells += 1;
        if (b.y0 < y && y < b.y1 && b.x0 < x && x < b.x1) { x = dir > 0 ? b.x1 : b.x0; moved = true; }
      }
    }
    return x;
  }

  /**
   * From `x` on row `y`, the end of the run of ruled-out spans in `dir` (1:
   * right, -1: left): the first point that way no block rules out, or `x`
   * itself when none does. Open spans meeting at a point leave it free. It
   * gives up, returning a point past `stop`, once the end is past it.
   */
  runEnd(x: number, y: number, dir: 1 | -1, stop: (x: number) => boolean): number {
    for (;;) {
      const before = x;
      const cell = this.cellAt(x, y);
      if (cell) {
        // Every block over x is in x's cell. One pass in edge order takes x
        // to where no block of the cell covers it (x only moves on, so a
        // block passed by can't cover it later).
        // A block over x starts less than the cell's widest block before it
        // (ends less than that after it), so the pass starts there.
        if (dir > 0) {
          const from = x - cell.widest;
          for (let i = firstNot(cell.byX0, (b) => b.x0 <= from); i < cell.byX0.length; i += 1) {
            const b = cell.byX0[i];
            if (this.work) this.work.cells += 1;
            if (b.x0 >= x) break;
            if (b.x1 > x && b.y0 < y && y < b.y1) x = b.x1;
          }
        } else {
          const from = x + cell.widest;
          for (let i = firstNot(cell.byX1, (b) => b.x1 >= from); i < cell.byX1.length; i += 1) {
            const b = cell.byX1[i];
            if (this.work) this.work.cells += 1;
            if (b.x1 <= x) break;
            if (b.x0 < x && b.y0 < y && y < b.y1) x = b.x0;
          }
        }
      }
      const passed = x;
      x = this.bigOut(x, y, dir);
      // Free (nothing moved it), or past the stop, where its end can't count.
      if (x === before || stop(x)) return x;
      // Still in the cell it was just passed through, and no big block over it: free.
      if (x === passed && this.cellAt(x, y) === cell) return x;
    }
  }
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
  const grid = new BlockGrid(occupied.map((o) => ({
    x0: Math.floor(o.x - gap - w), x1: Math.ceil(o.x + o.width + gap),
    y0: Math.floor(o.y - gap - h), y1: Math.ceil(o.y + o.height + gap),
  })), work);
  const ys = new Set<number>([clampY(wish.y)]);
  for (const edge of grid.edges) ys.add(clampY(edge));
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
  // Past this x, on a row `dy2` away, nothing can beat (or tie) the best spot.
  const beyond = (x: number, dy2: number) => found.best !== null && (x - wish.x) ** 2 + dy2 > found.best.d;
  // The free x nearest the wish on a row: the wish's own, or either end of
  // the run of ruled-out spans it falls in (open spans meeting at a point
  // leave it free). The run is walked out from the wish, cell by cell, and
  // stops once its end is past the view or out of reach.
  const tryRow = (y: number) => {
    const dy2 = (y - wish.y) ** 2;
    if (work) work.cells += 1;
    const hi = grid.runEnd(wishX, y, 1, (x) => x > xr.hi || (x >= wish.x && beyond(x, dy2)));
    if (hi === wishX) { consider(wishX, y); return; }
    if (hi <= xr.hi) consider(hi, y);
    const lo = grid.runEnd(wishX, y, -1, (x) => x < xr.lo || (x <= wish.x && beyond(x, dy2)));
    if (lo >= xr.lo) consider(lo, y);
  };
  // The outermost rows first: past every tile they are free, so on a crowded
  // board the best spot starts at most that far off and the rest of the
  // search keeps within reach of it. Any spot found is a real one, so the
  // stop below stays exact.
  if (rows.length > 2) {
    tryRow(rows.reduce((least, y) => Math.min(least, y)));
    tryRow(rows.reduce((most, y) => Math.max(most, y)));
  }
  for (const y of rows) {
    if (found.best && (y - wish.y) ** 2 > found.best.d) break;
    tryRow(y);
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
