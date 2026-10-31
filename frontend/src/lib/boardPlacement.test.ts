import { describe, expect, it } from 'vitest';
import { insideView, nearestFreeOutsideView, placeTiles } from './boardPlacement';
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

  it('nearestFreeOutsideView: the nearest free spot with no view to stay in', () => {
    const crowd = [{ x: 0, y: 0, width: 100, height: 100 }];
    expect(nearestFreeOutsideView({ x: 0, y: 0, width: 50, height: 50 }, crowd)).toEqual({ x: 0, y: -74 });
    expect(nearestFreeOutsideView({ x: 500, y: 500, width: 50, height: 50 }, crowd)).toEqual({ x: 500, y: 500 });
  });

  it('a tile bigger than the view goes outside it', () => {
    const { outside } = placeTiles({ at: { x: 0, y: 0 }, sizes: [[500, 500]], occupied: [], view: { x: 0, y: 0, width: 200, height: 200 } });
    expect(outside).toEqual([0]);
  });
});

describe('a drop', () => {
  it('lands where aimed when that is free, even partly past the view', () => {
    const view = { x: 0, y: 0, width: 1000, height: 700 };
    const { spots, outside } = placeTiles({ at: { x: 990, y: 350 }, sizes: [[200, 100]], occupied: [], view, aim: true });
    expect(spots).toEqual([{ x: 890, y: 300 }]);
    expect(outside).toEqual([0]);
  });

  it('slides to the nearest free spot when it would cover a tile', () => {
    const tile = { x: 0, y: 0, width: 400, height: 300 };
    const { spots } = placeTiles({ at: { x: 200, y: 290 }, sizes: [[200, 100]], occupied: [tile], view: { x: -500, y: -500, width: 2000, height: 2000 }, aim: true });
    // A small nudge: down below the tile.
    expect(spots).toEqual([{ x: 100, y: 324 }]);
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

  it('only the first file keeps its aim: an extra one never sits on its aim when that is taken', () => {
    const sizes: Array<[number, number]> = [[200, 100], [200, 100]];
    const { spots } = placeTiles({ at: { x: 500, y: 350 }, sizes, occupied: [], view: { x: 0, y: 0, width: 1000, height: 700 }, aim: true });
    expect(spots[1]).not.toEqual(spots[0]);
  });
});
