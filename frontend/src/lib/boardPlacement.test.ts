import { describe, expect, it } from 'vitest';
import { insideView, nearestFreeAnywhere, placeTiles } from './boardPlacement';
import type { NodeRect } from './nodePlacement';

// Where new tiles go on the Board view (GM - Design, #210 rulings): one helper
// for paste, Add images and drop. Never on a tile, in view when there's room,
// else just outside it; a drop keeps its aim unless it would cover a tile.

const GAP = 24;
const apart = (a: NodeRect, b: NodeRect) =>
  a.x + a.width + GAP <= b.x || b.x + b.width + GAP <= a.x || a.y + a.height + GAP <= b.y || b.y + b.height + GAP <= a.y;
const rectsOf = (spots: Array<{ x: number; y: number }>, sizes: Array<[number, number]>) =>
  spots.map((spot, i) => ({ ...spot, width: sizes[i][0], height: sizes[i][1] }));
const noOverlaps = (rects: NodeRect[]) => rects.every((a, i) => rects.slice(i + 1).every((b) => apart(a, b)));

/** The view at a zoom and pan, as the board reads it (screen 1000 x 700). */
const viewAt = (zoom: number, tx: number, ty: number): NodeRect => ({ x: -tx / zoom, y: -ty / zoom, width: 1000 / zoom, height: 700 / zoom });

describe('a paste onto a tile', () => {
  it('goes to the nearest free spot, not on it', () => {
    const tile = { x: 0, y: 0, width: 400, height: 300 };
    const { spots, outside } = placeTiles({ at: { x: 200, y: 150 }, sizes: [[200, 100]], occupied: [tile], view: { x: -1000, y: -1000, width: 3000, height: 3000 } });
    const placed = rectsOf(spots, [[200, 100]])[0];
    expect(apart(placed, tile)).toBe(true);
    expect(outside).toEqual([]);
    // Nearest: just below the tile (centred x kept), 24 px clear of it (above is
    // as near; the first found wins).
    expect(placed).toEqual({ x: 100, y: 324, width: 200, height: 100 });
  });

  it('a free point keeps the tile centred on it', () => {
    const { spots } = placeTiles({ at: { x: 1000, y: 1000 }, sizes: [[200, 100]], occupied: [{ x: 0, y: 0, width: 100, height: 100 }], view: null });
    expect(spots).toEqual([{ x: 900, y: 950 }]);
  });
});

describe('three files beside a crowded area', () => {
  it('overlap nothing, each other included, and all land in view', () => {
    const crowd: NodeRect[] = [];
    for (let row = 0; row < 3; row += 1) for (let col = 0; col < 3; col += 1) crowd.push({ x: col * 330, y: row * 230, width: 300, height: 200 });
    const view = { x: -200, y: -200, width: 1600, height: 1200 };
    const sizes: Array<[number, number]> = [[300, 200], [200, 300], [250, 250]];
    const { spots, outside } = placeTiles({ at: { x: 450, y: 330 }, sizes, occupied: crowd, view });
    const placed = rectsOf(spots, sizes);
    expect(noOverlaps([...crowd, ...placed])).toBe(true);
    expect(outside).toEqual([]);
    for (const rect of placed) expect(insideView(rect, view)).toBe(true);
  });
});

describe('every pasted tile lands fully in view', () => {
  const crowd: NodeRect[] = [{ x: 0, y: 0, width: 480, height: 270 }, { x: 520, y: 0, width: 480, height: 270 }];
  for (const [zoom, tx, ty] of [[0.5, 120, -40], [1, -300, 80], [2, -900, -100]] as const) {
    it(`at zoom ${zoom}, panned (${tx}, ${ty})`, () => {
      const view = viewAt(zoom, tx, ty);
      // The pointer near the view's right edge, over a tile when it can be.
      const at = { x: view.x + view.width - 10, y: view.y + view.height / 2 };
      const sizes: Array<[number, number]> = zoom === 2 ? [[100, 60], [80, 80], [60, 100]] : [[240, 160], [180, 180], [160, 240]];
      const { spots, outside } = placeTiles({ at, sizes, occupied: crowd, view });
      const placed = rectsOf(spots, sizes);
      expect(outside).toEqual([]);
      for (const rect of placed) expect(insideView(rect, view)).toBe(true);
      expect(noOverlaps([...crowd, ...placed])).toBe(true);
    });
  }
});

describe('no room in view', () => {
  it('the tile goes to the nearest free spot just outside, reported for the chip, overlapping nothing', () => {
    const view = { x: 0, y: 0, width: 1000, height: 300 };
    const crowd = [{ x: 0, y: 0, width: 480, height: 300 }, { x: 520, y: 0, width: 480, height: 300 }];
    const { spots, outside } = placeTiles({ at: { x: 500, y: 150 }, sizes: [[200, 150]], occupied: crowd, view });
    const placed = rectsOf(spots, [[200, 150]])[0];
    expect(outside).toEqual([0]);
    expect(insideView(placed, view)).toBe(false);
    expect(noOverlaps([...crowd, placed])).toBe(true);
    // Just outside: right below the crowd, under the point.
    expect(placed).toEqual({ x: 400, y: 324, width: 200, height: 150 });
  });

  it('nearestFreeAnywhere: the nearest free spot with no view to stay in', () => {
    const crowd = [{ x: 0, y: 0, width: 100, height: 100 }];
    expect(nearestFreeAnywhere({ x: 0, y: 0, width: 50, height: 50 }, crowd)).toEqual({ x: 0, y: -74 });
    expect(nearestFreeAnywhere({ x: 500, y: 500, width: 50, height: 50 }, crowd)).toEqual({ x: 500, y: 500 });
  });

  it('a tile bigger than the view goes outside it', () => {
    const { outside } = placeTiles({ at: { x: 0, y: 0 }, sizes: [[500, 500]], occupied: [], view: { x: 0, y: 0, width: 200, height: 200 } });
    expect(outside).toEqual([0]);
  });
});

describe('a drop', () => {
  it('lands where aimed when that is free, even partly past the view, with no chip (GM r4 answer 3)', () => {
    const view = { x: 0, y: 0, width: 1000, height: 700 };
    const { spots, outside } = placeTiles({ at: { x: 990, y: 350 }, sizes: [[200, 100]], occupied: [], view, aim: true });
    expect(spots).toEqual([{ x: 890, y: 300 }]);
    expect(outside).toEqual([]);
  });

  it('slides to the nearest free spot when it would cover a tile', () => {
    const tile = { x: 0, y: 0, width: 400, height: 300 };
    const { spots } = placeTiles({ at: { x: 200, y: 290 }, sizes: [[200, 100]], occupied: [tile], view: { x: -500, y: -500, width: 2000, height: 2000 }, aim: true });
    // A small nudge: down below the tile.
    expect(spots).toEqual([{ x: 100, y: 324 }]);
  });

  it('a nudge near the edge takes the nearest free spot even partly outside, with no chip (GM r4 answer 4)', () => {
    // A tile at the view's right edge; the drop lands on it. Right of it is
    // nearer than anywhere inside the view, and partly past the edge.
    const view = { x: 0, y: 0, width: 1000, height: 700 };
    const tile = { x: 700, y: 0, width: 200, height: 700 };
    const { spots, outside } = placeTiles({ at: { x: 960, y: 350 }, sizes: [[200, 100]], occupied: [tile], view, aim: true });
    expect(spots).toEqual([{ x: 924, y: 300 }]);
    expect(outside).toEqual([]);
  });

  it('a nudged aimed tile wholly out of view gets the chip', () => {
    const view = { x: 0, y: 0, width: 1000, height: 700 };
    const tile = { x: -100, y: -100, width: 1200, height: 900 };
    const { spots, outside } = placeTiles({ at: { x: 500, y: 650 }, sizes: [[200, 100]], occupied: [tile], view, aim: true });
    expect(spots).toEqual([{ x: 400, y: 824 }]);
    expect(outside).toEqual([0]);
  });

  it('an extra file of a drop partly past the edge gets the chip', () => {
    const view = { x: 0, y: 0, width: 1000, height: 700 };
    const crowd = [{ x: 0, y: 0, width: 1000, height: 560 }];
    const sizes: Array<[number, number]> = [[1000, 100], [200, 100]];
    const { spots, outside } = placeTiles({ at: { x: 500, y: 640 }, sizes, occupied: crowd, view, aim: true });
    expect(spots[0]).toEqual({ x: 0, y: 590 });
    expect(insideView(rectsOf(spots, sizes)[1], view)).toBe(false);
    expect(outside).toEqual([1]);
  });

  it('extra files fan out by the free-spot rule, inside the view', () => {
    const view = { x: 0, y: 0, width: 1000, height: 700 };
    const sizes: Array<[number, number]> = [[200, 100], [200, 100], [200, 100]];
    const { spots, outside } = placeTiles({ at: { x: 500, y: 350 }, sizes, occupied: [], view, aim: true });
    expect(spots[0]).toEqual({ x: 400, y: 300 });
    const placed = rectsOf(spots, sizes);
    expect(noOverlaps(placed)).toBe(true);
    expect(outside).toEqual([]);
  });

  it('an extra file of a drop keeps to the view when it has room (it is not aimed)', () => {
    // The first lands partly past the right edge, where it was aimed. The
    // second's nearest free spot anywhere is below it, partly outside too
    // (as near as the room left of it, and in the wish's own column); in
    // view it goes left of the first.
    const view = { x: 0, y: 0, width: 1000, height: 1000 };
    const sizes: Array<[number, number]> = [[100, 100], [100, 100]];
    const { spots, outside } = placeTiles({ at: { x: 980, y: 500 }, sizes, occupied: [], view, aim: true });
    expect(spots).toEqual([{ x: 930, y: 450 }, { x: 806, y: 450 }]);
    expect(insideView(rectsOf(spots, sizes)[1], view)).toBe(true);
    expect(outside).toEqual([]);
  });

  it('an aimed tile just touching the view from outside is wholly out of it: it gets the chip', () => {
    const view = { x: 0, y: 0, width: 1000, height: 700 };
    const { spots, outside } = placeTiles({ at: { x: 1050, y: 350 }, sizes: [[100, 100]], occupied: [], view, aim: true });
    expect(spots).toEqual([{ x: 1000, y: 300 }]);
    expect(outside).toEqual([0]);
  });

  it('only the first file keeps its aim: an extra one never sits on its aim when that is taken', () => {
    const sizes: Array<[number, number]> = [[200, 100], [200, 100]];
    const { spots } = placeTiles({ at: { x: 500, y: 350 }, sizes, occupied: [], view: { x: 0, y: 0, width: 1000, height: 700 }, aim: true });
    expect(spots[1]).not.toEqual(spots[0]);
  });
});

// Review 2, M1: the search is exact on any board size (it used only the 60
// tiles nearest the wish, so a big board's room in view was missed).
describe('big boards', () => {
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const isFree = (rect: NodeRect, occupied: NodeRect[]) => occupied.every((other) => apart(rect, other));
  /** Jittered tiles over `area`, none overlapping, skipping `hole`, up to `count`. */
  const board = (count: number, area: NodeRect, hole: NodeRect | null, start: number) => {
    seed = start;
    const tiles: NodeRect[] = [];
    for (let tries = 0; tiles.length < count && tries < 40_000; tries += 1) {
      const rect = { x: Math.round(area.x + rnd() * area.width), y: Math.round(area.y + rnd() * area.height),
        width: 150 + Math.round(rnd() * 200), height: 120 + Math.round(rnd() * 200) };
      if (hole && !(rect.x + rect.width + GAP <= hole.x || hole.x + hole.width + GAP <= rect.x
        || rect.y + rect.height + GAP <= hole.y || hole.y + hole.height + GAP <= rect.y)) continue;
      if (isFree(rect, tiles)) tiles.push(rect);
    }
    return tiles;
  };

  it('231 irregular tiles, zoomed out: three files all land in view (review 2 repro 1)', () => {
    const view = { x: -3000, y: -2000, width: 6000, height: 4000 };
    const occupied = board(231, { x: -3000, y: -2000, width: 6000, height: 4000 }, null, 99);
    expect(occupied.length).toBe(231);
    const sizes: Array<[number, number]> = [[300, 200], [200, 300], [250, 250]];
    const { spots, outside } = placeTiles({ at: { x: -2000, y: 0 }, sizes, occupied, view });
    expect(outside).toEqual([]);
    expect(noOverlaps([...occupied, ...rectsOf(spots, sizes)])).toBe(true);
  });

  it('a jittered board whose only room in view is one 600 x 600 gap far from the pointer (review 2 repro 2)', () => {
    // 360 x 260 cells, each with a 300 x 200 tile jittered by up to 36 px: at
    // most 96 px between tiles, so no 300 x 200 tile fits anywhere but the
    // gap, two by three cells cleared far from the pointer.
    seed = 11;
    const occupied: NodeRect[] = [];
    for (let row = 0; row < 15; row += 1) for (let col = 0; col < 17; col += 1) {
      if (col >= 13 && col <= 14 && row >= 6 && row <= 8) continue;
      occupied.push({ x: col * 360 + Math.round(rnd() * 36), y: row * 260 + Math.round(rnd() * 36), width: 300, height: 200 });
    }
    expect(occupied.length).toBe(249);
    expect(noOverlaps(occupied)).toBe(true);
    const view = { x: 0, y: 0, width: 17 * 360, height: 15 * 260 };
    const { spots, outside } = placeTiles({ at: { x: 200, y: 200 }, sizes: [[300, 200]], occupied, view });
    expect(outside).toEqual([]);
    const placed = rectsOf(spots, [[300, 200]])[0];
    expect(isFree(placed, occupied)).toBe(true);
    expect(insideView(placed, view)).toBe(true);
    // In the gap.
    expect(placed.x).toBeGreaterThanOrEqual(13 * 360 - 60);
    expect(placed.y).toBeGreaterThanOrEqual(6 * 260 - 60);
  });

  it('a gap exactly one tile and two gaps wide takes the tile (spans that only meet leave that point free)', () => {
    const left = { x: 0, y: 0, width: 100, height: 400 };
    const right = { x: 100 + 24 + 50 + 24, y: 0, width: 100, height: 400 };
    const view = { x: 0, y: 0, width: 298, height: 400 };
    const { spots, outside } = placeTiles({ at: { x: 149, y: 200 }, sizes: [[50, 50]], occupied: [left, right], view });
    expect(spots).toEqual([{ x: 124, y: 175 }]);
    expect(outside).toEqual([]);
  });

  it('reads only the rows near the wish when there is room near it', () => {
    // 500 tiles, the pointer over open ground beside them: a handful of rows.
    const occupied: NodeRect[] = [];
    for (let r = 0; r < 20; r += 1) for (let c = 0; c < 25; c += 1) occupied.push({ x: c * 324, y: r * 224, width: 300, height: 200 });
    const work = { cells: 0 };
    placeTiles({ at: { x: 4000, y: -600 }, sizes: [[300, 200]], occupied, view: { x: 0, y: -2000, width: 25 * 324, height: 7000 }, work });
    expect(work.cells).toBeLessThan(50);
  });

  it('agrees with a brute force on random boards, in view and anywhere', () => {
    const brute = (wish: NodeRect, occupied: NodeRect[], view: NodeRect | null) => {
      let best = Infinity;
      const reach = 400;
      const x0 = view ? Math.ceil(view.x) : wish.x - reach;
      const x1 = view ? Math.floor(view.x + view.width - wish.width) : wish.x + reach;
      const y0 = view ? Math.ceil(view.y) : wish.y - reach;
      const y1 = view ? Math.floor(view.y + view.height - wish.height) : wish.y + reach;
      for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) {
        const d = (x - wish.x) ** 2 + (y - wish.y) ** 2;
        if (d < best && isFree({ x, y, width: wish.width, height: wish.height }, occupied)) best = d;
      }
      return best;
    };
    seed = 3;
    for (let trial = 0; trial < 40; trial += 1) {
      const occupied: NodeRect[] = [];
      const count = 3 + Math.floor(rnd() * 10);
      for (let i = 0; i < count; i += 1) {
        occupied.push({ x: Math.round(rnd() * 260), y: Math.round(rnd() * 200), width: 20 + Math.round(rnd() * 70), height: 20 + Math.round(rnd() * 70) });
      }
      const view = { x: 0.4, y: 0.6, width: 300.5, height: 240.25 };
      const size: [number, number] = [30 + Math.round(rnd() * 40), 20 + Math.round(rnd() * 40)];
      const at = { x: rnd() * 300, y: rnd() * 240 };
      const wish = { x: Math.round(at.x - size[0] / 2), y: Math.round(at.y - size[1] / 2), width: size[0], height: size[1] };
      const { spots, outside } = placeTiles({ at, sizes: [size], occupied, view });
      const got = (spots[0].x - wish.x) ** 2 + (spots[0].y - wish.y) ** 2;
      const inView = brute(wish, occupied, view);
      expect(isFree({ ...spots[0], width: size[0], height: size[1] }, occupied)).toBe(true);
      if (inView < Infinity) {
        expect(outside).toEqual([]);
        expect(got).toBe(inView);
      } else {
        expect(outside).toEqual([0]);
        expect(got).toBe(brute(wish, occupied, null));
      }
    }
  });

  it('agrees with a brute force with a tile too big to file among them (a long one across the board)', () => {
    const brute = (wish: NodeRect, occupied: NodeRect[], view: NodeRect | null) => {
      let best = Infinity;
      const reach = 400;
      const x0 = view ? Math.ceil(view.x) : wish.x - reach;
      const x1 = view ? Math.floor(view.x + view.width - wish.width) : wish.x + reach;
      const y0 = view ? Math.ceil(view.y) : wish.y - reach;
      const y1 = view ? Math.floor(view.y + view.height - wish.height) : wish.y + reach;
      for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) {
        const d = (x - wish.x) ** 2 + (y - wish.y) ** 2;
        if (d < best && isFree({ x, y, width: wish.width, height: wish.height }, occupied)) best = d;
      }
      return best;
    };
    seed = 11;
    for (let trial = 0; trial < 40; trial += 1) {
      const occupied: NodeRect[] = [];
      const count = 3 + Math.floor(rnd() * 10);
      for (let i = 0; i < count; i += 1) {
        occupied.push({ x: Math.round(rnd() * 260), y: Math.round(rnd() * 200), width: 20 + Math.round(rnd() * 70), height: 20 + Math.round(rnd() * 70) });
      }
      // Far taller than the grid's cells, so it is kept in the list every step reads.
      occupied.push({ x: Math.round(rnd() * 260), y: -3000, width: 10 + Math.round(rnd() * 30), height: 6000 });
      const view = { x: 0.4, y: 0.6, width: 300.5, height: 240.25 };
      const size: [number, number] = [30 + Math.round(rnd() * 40), 20 + Math.round(rnd() * 40)];
      const at = { x: rnd() * 300, y: rnd() * 240 };
      const wish = { x: Math.round(at.x - size[0] / 2), y: Math.round(at.y - size[1] / 2), width: size[0], height: size[1] };
      const { spots, outside } = placeTiles({ at, sizes: [size], occupied, view });
      const got = (spots[0].x - wish.x) ** 2 + (spots[0].y - wish.y) ** 2;
      const inView = brute(wish, occupied, view);
      expect(isFree({ ...spots[0], width: size[0], height: size[1] }, occupied)).toBe(true);
      if (inView < Infinity) {
        expect(outside).toEqual([]);
        expect(got).toBe(inView);
      } else {
        expect(outside).toEqual([0]);
        expect(got).toBe(brute(wish, occupied, null));
      }
    }
  });

  it('a run of spans that only just overlap (by one pixel) is walked to its true end, both ways', () => {
    // Tall tiles, so every row of the view is the same. The new tile (50 wide)
    // is ruled out of 126 < x < 324 by the middle tile; the left one rules out
    // -71 < x < 127, one pixel past 126, so 126 is not free.
    const middle = { x: 200, y: 0, width: 100, height: 1000 };
    const view = { x: -500, y: 0, width: 1500, height: 1000 };
    const left = placeTiles({ at: { x: 175, y: 425 }, sizes: [[50, 50]], occupied: [{ x: 3, y: 0, width: 100, height: 1000 }, middle], view });
    expect(left.spots).toEqual([{ x: 324, y: 400 }]);
    // Mirrored: the right tile rules out 323 < x < 521, one pixel before 324.
    const right = placeTiles({ at: { x: 315, y: 425 }, sizes: [[50, 50]], occupied: [middle, { x: 397, y: 0, width: 100, height: 1000 }], view });
    expect(right.spots).toEqual([{ x: 126, y: 400 }]);
  });

  // Every block the search reads is counted (review 3, LOW-1), on the board
  // shapes that cost most: a jittered grid with no room in view, one long
  // band of tall tiles, one very tall tile beside a field, and a grid of
  // distinct heights (every row its own). Five files each.
  const shapes = (n: number) => {
    const sizes = Array.from({ length: 5 }, (_, i) => [300 - i * 20, 200 + i * 10] as [number, number]);
    seed = 7;
    const cols = n === 500 ? 25 : 50;
    const rows = n / cols;
    const grid: NodeRect[] = [];
    for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) {
      grid.push({ x: c * 360 + Math.round(rnd() * 36), y: r * 260 + Math.round(rnd() * 36), width: 300, height: 200 });
    }
    const band: NodeRect[] = [];
    for (let i = 0; i < n; i += 1) band.push({ x: i * 224, y: Math.round(rnd() * 150), width: 200, height: 400 });
    const tall: NodeRect[] = [{ x: -100000, y: -50000, width: 100, height: 100000 }];
    for (let i = 0; i < n - 1; i += 1) {
      tall.push({ x: (i % 20) * 230 + Math.round(rnd() * 5), y: Math.floor(i / 20) * 130 + Math.round(rnd() * 5), width: 200, height: 100 });
    }
    const tallHeight = Math.floor((n - 1) / 20) * 130;
    const distinct: NodeRect[] = [];
    for (let i = 0; i < n; i += 1) {
      distinct.push({ x: (i % 25) * 330, y: Math.floor(i / 25) * 240 + (i % 7), width: 300 + (i % 5), height: 200 + (i % 11) });
    }
    return [
      { name: 'grid', sizes, occupied: grid, view: { x: 0, y: 0, width: cols * 360, height: rows * 260 }, at: { x: cols * 180, y: rows * 130 } },
      { name: 'band', sizes, occupied: band, view: { x: (n / 2) * 224 - 2000, y: 100, width: 4000, height: 300 }, at: { x: (n / 2) * 224, y: 300 } },
      { name: 'tall tile', sizes, occupied: tall, view: { x: 0, y: 0, width: 20 * 230, height: tallHeight }, at: { x: 2300, y: tallHeight / 2 } },
      { name: 'distinct heights', sizes, occupied: distinct, view: { x: 0, y: 0, width: 25 * 330, height: (n / 25) * 240 },
        at: { x: 4000, y: (n / 25) * 120 } },
    ];
  };

  it.each([[500, 450_000], [2000, 2_500_000]])('stays fast at %i tiles: every block read counts, on every costly shape', (n, bound) => {
    for (const shape of shapes(n)) {
      const work = { cells: 0 };
      const { spots, outside } = placeTiles({ at: shape.at, sizes: shape.sizes, occupied: shape.occupied, view: shape.view, work });
      // None of them has room in view: each file reads its whole view, then searches anywhere.
      expect(outside, shape.name).toEqual([0, 1, 2, 3, 4]);
      expect(noOverlaps([...shape.occupied, ...rectsOf(spots, shape.sizes)]), shape.name).toBe(true);
      expect(work.cells, shape.name).toBeLessThan(bound);
    }
  });

  it('a long band of tall tiles costs little: the search reads near the wish, not the whole band', () => {
    const band = shapes(2000)[1];
    const work = { cells: 0 };
    placeTiles({ at: band.at, sizes: band.sizes, occupied: band.occupied, view: band.view, work });
    expect(work.cells).toBeLessThan(40_000);
  });

  it('a very tall tile far off adds little: it is read once per step, not with every tile on each row', () => {
    const field: NodeRect[] = [];
    for (let i = 0; i < 400; i += 1) field.push({ x: (i % 20) * 230, y: Math.floor(i / 20) * 130, width: 200, height: 100 });
    const view = { x: 0, y: 0, width: 4600, height: 2600 };
    const cost = (occupied: NodeRect[]) => {
      const work = { cells: 0 };
      const placed = placeTiles({ at: { x: 2300, y: 1300 }, sizes: [[200, 100]], occupied, view, work });
      return { work: work.cells, placed };
    };
    const plain = cost(field);
    const tall = cost([{ x: -100000, y: -50000, width: 100, height: 100000 }, ...field]);
    expect(tall.placed).toEqual(plain.placed);
    expect(plain.placed).toEqual({ spots: [{ x: 2200, y: 2594 }], outside: [0] });
    expect(tall.work).toBeLessThan(plain.work * 1.25);
  });
});
