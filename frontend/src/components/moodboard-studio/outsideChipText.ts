/** The outside-the-view chip's words, edge and place (GM - Design, #210 answers; GM r13); OutsideChip draws them. */

import type { NodeRect } from '../../lib/nodePlacement';

export type ChipEdge = 'left' | 'right' | 'top' | 'bottom';

/** The chip's words (GM, #210 answer 1). */
export function outsideChipText(count: number): { text: string; label: string } {
  return count === 1
    ? { text: 'Added outside the view', label: 'Added outside the view, show it' }
    : { text: `${count} images added outside the view`, label: `${count} images added outside the view, show them` };
}

/** The edge of `view` nearest a point, both in the board's screen pixels:
 *  the side the point lies furthest past, measured against the view's own
 *  half-width and half-height. */
export function nearestEdge(point: { x: number; y: number }, view: NodeRect): ChipEdge {
  const dx = (point.x - (view.x + view.width / 2)) / (view.width / 2 || 1);
  const dy = (point.y - (view.y + view.height / 2)) / (view.height / 2 || 1);
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'top' : 'bottom';
}

/** Room kept between the chip and the board's corners, in screen pixels. */
export const CHIP_CORNER = 48;
/** The chip's distance from the edge it sits on. */
export const CHIP_EDGE = 12;

export interface ChipPlace {
  edge: ChipEdge;
  /** The chip's centre, in the board's screen pixels. */
  centre: { x: number; y: number };
  /** Where the arrow points, in degrees clockwise from pointing right (→): at the first tile's centre. */
  turn: number;
  /** The arrow comes before the words (the tile is left of the chip) or after them. */
  arrowFirst: boolean;
}

const overlap = (a: NodeRect, b: NodeRect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Where the chip sits (GM r13): on the view's edge nearest the first tile,
 * centred on that edge, its arrow pointing at the tile. Never on a tile it
 * points at: when the centred chip would cover part of one (a tile poking
 * into the view there), it slides along the edge to the nearest place clear
 * of them; with no such place, it steps in from the edge past them.
 *
 * All in the board's screen pixels: `pane` is the board's size, `view` the
 * view placement uses (inside the insets, above the toolbar), `floor` the
 * lowest line the chip may reach (above the toolbar and the notices), `size`
 * the chip's own, and `tiles` the tiles it points at.
 */
export function placeChip({ pane, view, floor, size, tiles }: {
  pane: { width: number; height: number };
  view: NodeRect;
  floor: number;
  size: { w: number; h: number };
  tiles: ReadonlyArray<NodeRect>;
}): ChipPlace {
  const first = tiles[0];
  const target = { x: first.x + first.width / 2, y: first.y + first.height / 2 };
  const edge = nearestEdge(target, view);
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
  const top = view.y;
  const bottom = Math.min(view.y + view.height, floor, pane.height);
  const left = Math.max(0, view.x);
  const right = Math.min(pane.width, view.x + view.width);
  const horizontal = edge === 'top' || edge === 'bottom';
  // The centre's range along the edge, the chip whole inside the view.
  const low = horizontal ? left + size.w / 2 + CHIP_EDGE : top + Math.max(CHIP_CORNER, size.h / 2 + CHIP_EDGE);
  const high = horizontal ? right - size.w / 2 - CHIP_EDGE : bottom - Math.max(CHIP_CORNER, size.h / 2 + CHIP_EDGE);
  // Its distance in from the edge, centre to edge.
  const depth = (horizontal ? size.h : size.w) / 2 + CHIP_EDGE;
  const at = (along: number, inset: number) => {
    switch (edge) {
      case 'top': return { x: along, y: top + inset };
      case 'bottom': return { x: along, y: bottom - inset };
      case 'left': return { x: left + inset, y: along };
      default: return { x: right - inset, y: along };
    }
  };
  const boxAt = (centre: { x: number; y: number }) => ({ x: centre.x - size.w / 2, y: centre.y - size.h / 2, width: size.w, height: size.h });
  const clear = (centre: { x: number; y: number }) => !tiles.some((tile) => overlap(boxAt(centre), tile));

  const middle = clamp(horizontal ? (left + right) / 2 : (top + bottom) / 2, low, high);
  let centre = at(middle, depth);
  if (!clear(centre)) {
    // Slide along the edge: just past each tile's ends, nearest the middle first.
    const stops = tiles.flatMap((tile) => (horizontal
      ? [tile.x - size.w / 2 - 1, tile.x + tile.width + size.w / 2 + 1]
      : [tile.y - size.h / 2 - 1, tile.y + tile.height + size.h / 2 + 1]))
      .filter((along) => along >= low && along <= high)
      .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
    const slid = stops.map((along) => at(along, depth)).find(clear);
    if (slid) centre = slid;
    else {
      // No room along it: in from the edge, past the tiles' near sides.
      const inset = Math.max(depth, ...tiles.map((tile) => {
        switch (edge) {
          case 'top': return tile.y + tile.height - top + size.h / 2 + 1;
          case 'bottom': return bottom - tile.y + size.h / 2 + 1;
          case 'left': return tile.x + tile.width - left + size.w / 2 + 1;
          default: return right - tile.x + size.w / 2 + 1;
        }
      }));
      centre = at(middle, inset);
    }
  }
  const turn = Math.round((Math.atan2(target.y - centre.y, target.x - centre.x) * 180) / Math.PI);
  return { edge, centre, turn, arrowFirst: edge === 'left' || (horizontal && target.x < centre.x) };
}
