import type { Box, Point } from './agentAnchorResolve';
import { AGENT_CURSOR_CHIP } from './agentCursorTuning';

/**
 * Where the canvas's edge chips go (PR #233 slice 9; GM - Design 7 and 8).
 * Pure: client pixels in, boxes out, so placement is tested without a page.
 *
 * A canvas cursor whose tip is off screen gets a chip pointing to it:
 * - **Outside the visible pane** (the canvas minus the open docks): the chip
 *   sits at the pane's edge, `insetPx` in, where the line from the pane's
 *   middle to the tip crosses it.
 * - **Under floating chrome** (the Inspector, the Agent log, Updates): the
 *   chip sits just outside that panel's edge, on the side facing the pane's
 *   middle, `insetPx` clear of it, where the same line leaves the panel.
 * - **Clear of the canvas's chrome** (the top bar, the bottom bar, the rail,
 *   Updates, the Agent log, the chat button, the undo toast, the open
 *   panels): a chip never overlaps a `chrome` box. It slides along its edge
 *   to the nearest free spot, `chromeGapPx` clear; where the edge has no room
 *   it moves inward (or off a panel, outward) past the chrome that blocks it.
 * Chips on one edge stack along it `gapPx` apart and never overlap, any
 * other chip or "+N" included; an edge holds at most `maxPerEdge` (the most
 * recently active) and then a count, which is not a control.
 *
 * In the cursor chunk (lib/deferredChunks.ts DEFERRED_MODULES).
 */

export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface ChipCursor {
  key: string;
  label: string;
  color: string;
  /** The cursor's tip, client px. */
  tip: Point;
  /** More recent is larger (the most recently active keep their chip). */
  activeAt: number;
}

/** A floating panel a cursor can be under. */
export interface Obstacle { id: string; box: Box }

export interface PlacedChip {
  key: string;
  label: string;
  color: string;
  box: Box;
  /** Radians, from the chip's middle toward the tip (the chevron). */
  angle: number;
  /** The edge it is on: a new chip slides in from beyond it. */
  side: Side;
}

export interface PlacedCount { id: string; count: number; box: Box; side: Side }

export interface ChipPlan { chips: PlacedChip[]; counts: PlacedCount[] }

export interface ChipSizes {
  /** A chip's box size (its width depends on its name). */
  chip(cursor: ChipCursor): { width: number; height: number };
  count: { width: number; height: number };
}

/** The chip's width reckoned from its name when it can't be measured: the 1 px border each side, padding, dot, the
 *  two gaps, the name at 8 px a letter and the chevron. The name is what the CSS ellipsis cuts: at 7 px a letter
 *  and no border, "Claude" (40.3 px at 12 px type) came out "Clau…" and "Codex" (36.7 px) "Co…". */
export function estimateChipWidth(label: string): number {
  return Math.min(AGENT_CURSOR_CHIP.maxWidthPx, 2 + 16 + 6 + 6 + Math.ceil(label.length * 8) + 6 + 10);
}

export const defaultSizes: ChipSizes = {
  chip: (cursor) => ({ width: estimateChipWidth(cursor.label), height: AGENT_CURSOR_CHIP.heightPx }),
  count: { width: AGENT_CURSOR_CHIP.countWidthPx, height: AGENT_CURSOR_CHIP.countHeightPx },
};

const inside = (p: Point, box: Box): boolean =>
  p.x >= box.left && p.x <= box.left + box.width && p.y >= box.top && p.y <= box.top + box.height;
const centreOf = (box: Box): Point => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
const overlaps = (a: Box, b: Box, gap = 0): boolean =>
  a.left < b.left + b.width + gap && b.left < a.left + a.width + gap
  && a.top < b.top + b.height + gap && b.top < a.top + a.height + gap;

/** A group of chips that share an edge: the pane's or a panel's. */
interface Group {
  id: string;
  side: Side;
  /** A panel's face: the chips stand off it, outside the panel. Else they sit inside the pane, off its edge. */
  outside: boolean;
  /** The line (x for left and right, y for top and bottom) the chips' near edge is on. */
  line: number;
  /** The stretch along the edge a chip's middle may take. */
  along: [number, number];
  members: { cursor: ChipCursor; size: { width: number; height: number }; natural: number }[];
}

/** Where a ray from `from` toward `to` first leaves `box` (`from` inside it): the point and the face. */
function leaves(from: Point, to: Point, box: Box): { point: Point; side: Side } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const tx = dx > 0 ? (box.left + box.width - from.x) / dx : dx < 0 ? (box.left - from.x) / dx : Infinity;
  const ty = dy > 0 ? (box.top + box.height - from.y) / dy : dy < 0 ? (box.top - from.y) / dy : Infinity;
  const t = Math.min(tx, ty);
  const side: Side = tx <= ty ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
  return { point: { x: from.x + dx * t, y: from.y + dy * t }, side };
}

const vertical = (side: Side): boolean => side === 'left' || side === 'right';
const faceLine = (box: Box, side: Side): number => side === 'left' ? box.left : side === 'right' ? box.left + box.width
  : side === 'top' ? box.top : box.top + box.height;
/** How far `p` (inside `box`) is from a face of it. */
const faceDistance = (p: Point, box: Box, side: Side): number => Math.abs((vertical(side) ? p.x : p.y) - faceLine(box, side));

/**
 * Plans the chips for `cursors` (tips in client px). `view` is the visible
 * pane; `obstacles` the floating panels. A cursor inside `view` and under no
 * panel has no chip.
 */
export function planChips({ view, obstacles = [], chrome = [], cursors, sizes = defaultSizes }: {
  view: Box;
  obstacles?: readonly Obstacle[];
  /** Fixed canvas chrome a chip must stand clear of. A cursor under one is not off screen: this only keeps chips off it. */
  chrome?: readonly Box[];
  cursors: readonly ChipCursor[];
  sizes?: ChipSizes;
}): ChipPlan {
  const { insetPx, gapPx, chromeGapPx, maxPerEdge } = AGENT_CURSOR_CHIP;
  const centre = centreOf(view);
  const groups = new Map<string, Group>();
  const order: Group[] = [];
  const add = (group: Omit<Group, 'members'>, member: Group['members'][number]) => {
    const key = `${group.id}:${group.side}`;
    let found = groups.get(key);
    if (!found) {
      found = { ...group, members: [] };
      groups.set(key, found);
      order.push(found);
    }
    found.members.push(member);
  };

  for (const cursor of cursors) {
    const size = sizes.chip(cursor);
    if (!inside(cursor.tip, view)) {
      // At the pane's edge: where the line from the middle to the tip crosses the inset rect,
      // the chip's whole box inside it.
      const halfW = Math.max(0, view.width / 2 - insetPx - size.width / 2);
      const halfH = Math.max(0, view.height / 2 - insetPx - size.height / 2);
      const dx = cursor.tip.x - centre.x;
      const dy = cursor.tip.y - centre.y;
      const sx = dx === 0 ? Infinity : halfW / Math.abs(dx);
      const sy = dy === 0 ? Infinity : halfH / Math.abs(dy);
      const side: Side = sx <= sy ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
      const s = Math.min(sx, sy, 1);
      const at = { x: centre.x + dx * s, y: centre.y + dy * s };
      const line = side === 'left' ? view.left + insetPx
        : side === 'right' ? view.left + view.width - insetPx
          : side === 'top' ? view.top + insetPx : view.top + view.height - insetPx;
      add({ id: 'view', side, outside: false, line, along: vertical(side)
        ? [view.top + insetPx, view.top + view.height - insetPx] : [view.left + insetPx, view.left + view.width - insetPx] },
      { cursor, size, natural: vertical(side) ? at.y : at.x });
      continue;
    }
    const under = obstacles.filter((o) => inside(cursor.tip, o.box))
      .sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)[0];
    if (!under) continue;
    // Just outside the panel's edge that faces the pane's middle: the box grown by the inset.
    // Where that leaves no room inside the pane, the next nearest face does.
    const grown = { left: under.box.left - insetPx, top: under.box.top - insetPx,
      width: under.box.width + 2 * insetPx, height: under.box.height + 2 * insetPx };
    const out = leaves(cursor.tip, centre, grown);
    const faces: Side[] = (['left', 'right', 'top', 'bottom'] as Side[])
      .sort((a, b) => faceDistance(cursor.tip, grown, a) - faceDistance(cursor.tip, grown, b));
    const candidates: Side[] = [out.side, ...faces.filter((face) => face !== out.side)];
    const fits = (side: Side) => {
      const line = faceLine(grown, side);
      const room = side === 'left' ? line - (view.left + insetPx) - size.width
        : side === 'right' ? view.left + view.width - insetPx - line - size.width
          : side === 'top' ? line - (view.top + insetPx) - size.height : view.top + view.height - insetPx - line - size.height;
      return room >= 0;
    };
    const side = candidates.find(fits) ?? out.side;
    const along = vertical(side) ? Math.min(Math.max(cursor.tip.y, grown.top), grown.top + grown.height)
      : Math.min(Math.max(cursor.tip.x, grown.left), grown.left + grown.width);
    add({ id: under.id, side, outside: true, line: faceLine(grown, side), along: vertical(side)
      ? [view.top + insetPx, view.top + view.height - insetPx] : [view.left + insetPx, view.left + view.width - insetPx] },
    { cursor, size, natural: side === out.side ? (vertical(side) ? out.point.y : out.point.x) : along });
  }

  const placed: Box[] = [];
  const chips: PlacedChip[] = [];
  const counts: PlacedCount[] = [];
  // The pane's edges first (top, bottom, left, right), then each panel's: a stack
  // sees what is already down, so no two ever overlap.
  const rank = (group: Group) => (group.id === 'view' ? 0 : 1) * 4 + ['top', 'bottom', 'left', 'right'].indexOf(group.side);
  for (const group of [...order].sort((a, b) => rank(a) - rank(b))) {
    const { side } = group;
    const shown = [...group.members].sort((a, b) => b.cursor.activeAt - a.cursor.activeAt || (a.cursor.key < b.cursor.key ? -1 : 1))
      .slice(0, maxPerEdge);
    const keep = new Set(shown.map((m) => m.cursor.key));
    let hidden = group.members.length - shown.length;
    const stack = group.members.filter((m) => keep.has(m.cursor.key)).sort((a, b) => a.natural - b.natural
      || (a.cursor.key < b.cursor.key ? -1 : 1));
    const [lo, hi] = group.along;
    // Which way a chip's depth grows: inward from the pane's edge, away from a panel's face.
    const dir = (group.outside ? -1 : 1) * (side === 'left' || side === 'top' ? 1 : -1);
    const bounds: [number, number] = vertical(side) ? [view.left + insetPx, view.left + view.width - insetPx]
      : [view.top + insetPx, view.top + view.height - insetPx];
    // On the pane's edge a chip extends inward from its line; off a panel's face, away from the panel.
    // `depth` moves the line on, past chrome that holds the edge.
    const boxAt = (size: { width: number; height: number }, centreAlong: number, depth = 0): Box => {
      const w = size.width;
      const h = size.height;
      const inward = !group.outside;
      const line = group.line + dir * depth;
      if (side === 'left') return { left: inward ? line : line - w, top: centreAlong - h / 2, width: w, height: h };
      if (side === 'right') return { left: inward ? line - w : line, top: centreAlong - h / 2, width: w, height: h };
      if (side === 'top') return { left: centreAlong - w / 2, top: inward ? line : line - h, width: w, height: h };
      return { left: centreAlong - w / 2, top: inward ? line - h : line, width: w, height: h };
    };
    const extent = (size: { width: number; height: number }) => (vertical(side) ? size.height : size.width);
    const alongStart = (box: Box) => (vertical(side) ? box.top : box.left);
    const alongEnd = (box: Box) => (vertical(side) ? box.top + box.height : box.left + box.width);
    const acrossStart = (box: Box) => (vertical(side) ? box.left : box.top);
    const acrossEnd = (box: Box) => (vertical(side) ? box.left + box.width : box.top + box.height);
    /** The depths to try: the edge itself, then each way past a chrome box. */
    const depths = (size: { width: number; height: number }): number[] => {
      const base = boxAt(size, 0);
      const found = new Set<number>([0]);
      for (const c of chrome) {
        const d = dir > 0 ? acrossEnd(c) + chromeGapPx - acrossStart(base) : acrossEnd(base) - (acrossStart(c) - chromeGapPx);
        if (d <= 0) continue;
        const moved = boxAt(size, 0, d);
        if (acrossStart(moved) >= bounds[0] - 1e-6 && acrossEnd(moved) <= bounds[1] + 1e-6) found.add(d);
      }
      return [...found].sort((x, y) => x - y);
    };
    /** The nearest spot to `from` along the edge at `depth` where `size` is clear of everything placed and of the chrome, or null.
     *  Past a chip it only goes on (the stack keeps its order); around chrome it may go either way. */
    const settleAt = (size: { width: number; height: number }, from: number, depth: number): number | null => {
      const half = extent(size) / 2;
      const start = Math.max(from, lo + half);
      const candidates = [start];
      for (const other of placed) candidates.push(alongEnd(other) + gapPx + half);
      for (const c of chrome) candidates.push(alongEnd(c) + chromeGapPx + half, alongStart(c) - chromeGapPx - half);
      let best: number | null = null;
      for (const pos of candidates) {
        if (pos < lo + half - 1e-6 || pos + half > hi + 1e-6) continue;
        const box = boxAt(size, pos, depth);
        if (placed.some((other) => overlaps(box, other, gapPx)) || chrome.some((c) => overlaps(box, c, chromeGapPx))) continue;
        const gap = Math.abs(pos - start);
        if (best === null || gap < Math.abs(best - start) || (gap === Math.abs(best - start) && pos > best)) best = pos;
      }
      return best;
    };
    /** Where `size` goes: the first depth with a free spot, and the nearest spot to `from` on it. */
    const settle = (size: { width: number; height: number }, from: number): { pos: number; depth: number } | null => {
      for (const depth of depths(size)) {
        const pos = settleAt(size, from, depth);
        if (pos !== null) return { pos, depth };
      }
      return null;
    };
    let last = -Infinity;
    for (const member of stack) {
      const spot = settle(member.size, member.natural);
      if (spot === null) { hidden += 1; continue; }
      const box = boxAt(member.size, spot.pos, spot.depth);
      placed.push(box);
      last = spot.pos + extent(member.size) / 2;
      const c = centreOf(box);
      chips.push({ key: member.cursor.key, label: member.cursor.label, color: member.cursor.color, box, side,
        angle: Math.atan2(member.cursor.tip.y - c.y, member.cursor.tip.x - c.x) });
    }
    if (hidden > 0) {
      // The count follows the last chip on the same line; with no room it is left out.
      const size = sizes.count;
      const spot = settle(size, last === -Infinity ? stack[0]?.natural ?? lo : last + gapPx + extent(size) / 2);
      if (spot !== null) {
        const box = boxAt(size, spot.pos, spot.depth);
        placed.push(box);
        counts.push({ id: `${group.id}:${side}`, count: hidden, box, side });
      }
    }
  }
  return { chips, counts };
}

/** The accessible names (GM - Design 7 and 8): "Claude, show where it’s working", "+2 agents off screen". */
export const chipName = (label: string): string => `${label}, show where it’s working`;
export const countName = (count: number): string => `+${count} agent${count === 1 ? '' : 's'} off screen`;
