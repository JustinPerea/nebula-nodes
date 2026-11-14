import type { Point } from './agentCursorMotion';
import { AGENT_CURSOR_ARROW_POINTS, AGENT_CURSOR_ARROW_STROKE, AGENT_CURSOR_ARROW_TIP, AGENT_CURSOR_ARROW_TOP, AGENT_CURSOR_PILL } from './agentCursorLook';

/**
 * The edge park's chevron (Phase 3 slice 7; design section 5): a target in
 * an open panel but scrolled out of view parks the cursor just inside the
 * panel's edge (lib/agentAnchorResolve.ts clampToClip), and a 6 px chevron
 * in the agent colour, 4 px from the arrow, points toward the item. Pure, so
 * the angle and the place are tested without a page. In the cursor chunk
 * (lib/deferredChunks.ts DEFERRED_MODULES).
 */

export const PARK_CHEVRON_PX = 6;
export const PARK_CHEVRON_GAP_PX = 4;

// The arrow's extent from its tip, right and down (it never points up or left).
const ARROW_RIGHT_PX = Math.max(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.x)) - AGENT_CURSOR_ARROW_TIP.x;
const ARROW_DOWN_PX = Math.max(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.y)) - AGENT_CURSOR_ARROW_TIP.y;

/** How far from the tip, along `angle`, the arrow's box ends: 0 for a
 *  direction that leaves it at once (up or left of the tip, by enough that
 *  the chevron's own width stands clear). A direction a hair past straight
 *  down (or right) has a slightly negative cosine (sine) and its chevron
 *  would still sit on the arrow's edge, so only a component that clears the
 *  chevron by the time it is placed counts as leaving; the rest leave by the
 *  far side. (The bottom park's chevron hid under the arrow when the item's
 *  middle was a pixel left of the tip.) */
export function arrowExitPx(angle: number): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const placed = PARK_CHEVRON_GAP_PX + PARK_CHEVRON_PX / 2;
  const clears = PARK_CHEVRON_PX / 2;
  if (-dx * placed >= clears || -dy * placed >= clears) return 0;
  return Math.min(dx > 0 ? ARROW_RIGHT_PX / dx : Infinity, dy > 0 ? ARROW_DOWN_PX / dy : Infinity);
}

/** The chevron for a cursor drawn with its tip at `tip`, whose item is at
 *  `toward` (client px): the angle (radians, 0 along +x) to it, and the
 *  distance from the tip to the chevron's middle: clear of the arrow by
 *  `PARK_CHEVRON_GAP_PX`. */
export function parkChevron(tip: Point, toward: Point): { angle: number; distance: number } {
  const angle = Math.atan2(toward.y - tip.y, toward.x - tip.x);
  return { angle, distance: arrowExitPx(angle) + PARK_CHEVRON_GAP_PX + PARK_CHEVRON_PX / 2 };
}

/** How far right and down of the tip the drawn cursor reaches when it parks
 *  with its chevron at `angle`: the arrow with its stroke, or the chevron
 *  placed at `parkChevron`'s distance with its own stroke, whichever goes
 *  further. The edge park's clamp keeps these inside the clip (agentAnchorResolve
 *  clampToClip). From the tuning constants, never a layout read. */
export function parkReachPx(angle: number): { right: number; down: number } {
  const half = AGENT_CURSOR_ARROW_STROKE / 2;
  const distance = arrowExitPx(angle) + PARK_CHEVRON_GAP_PX + PARK_CHEVRON_PX / 2;
  const chevronHalf = PARK_CHEVRON_PX / 2 + 0.75;
  return {
    right: Math.max(ARROW_RIGHT_PX + half, Math.cos(angle) * distance + chevronHalf),
    down: Math.max(ARROW_DOWN_PX + half, Math.sin(angle) * distance + chevronHalf),
  };
}

interface Rect { left: number; top: number; right: number; bottom: number }

/** How far inside the panel's edge the pills keep, and from the arrow and chevron. */
export const PARK_LABEL_INSET_PX = 8;
export const PARK_LABEL_CLEAR_PX = 4;
/** A say wraps to two lines at this width (agentCursor.css `.agent-cursor__say`). */
const SAY_TWO_LINES_AT_PX = 260;
const SAY_TWO_LINES_PX = 36;

const overlap = (a: Rect, b: Rect, pad = 0) =>
  a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;

/**
 * Where a parked cursor's pills go so they stay inside the panel and clear
 * of the arrow and the chevron (GM r136, ruling 4). The pills sit right of
 * the arrow and below its top by default; a say wider than the room to the
 * panel's edge, or one that would run under the panel's bottom, is moved:
 * slid left to fit, and when that puts it on the arrow or the chevron, or
 * under the bottom, set above the arrow instead. The offset is the label's
 * own (`translate`), in px; `{ x: 0, y: 0 }` leaves it where it is. Pure:
 * the pills' widths are the ones the field measured, never a layout read.
 */
export function parkLabelNudge(o: {
  /** The cursor's origin (its drawn position), client px. */
  origin: Point;
  /** The panel box the cursor is parked at the edge of. */
  clip: Rect;
  nameShown: boolean;
  nameW: number;
  /** 0 when no say shows. */
  sayW: number;
  /** The chevron's middle, client px. */
  chevron: Point | null;
}): Point {
  const { origin, clip, nameShown, nameW, sayW } = o;
  const { left, top, height, gap, ring } = AGENT_CURSOR_PILL;
  if (!nameShown && sayW <= 0) return { x: 0, y: 0 };
  const sayH = sayW >= SAY_TWO_LINES_AT_PX ? SAY_TWO_LINES_PX : height;
  const width = Math.max(nameShown ? nameW + ring : 0, sayW);
  const blockH = (nameShown && sayW > 0 ? height + gap : 0) + (sayW > 0 ? sayH : height);
  const home: Rect = { left: origin.x + left, top: origin.y + top, right: origin.x + left + width, bottom: origin.y + top + blockH };
  const half = AGENT_CURSOR_ARROW_STROKE / 2;
  const arrow: Rect = {
    left: origin.x + Math.min(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.x)) - half,
    right: origin.x + Math.max(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.x)) + half,
    top: origin.y + AGENT_CURSOR_ARROW_TOP,
    bottom: origin.y + Math.max(...AGENT_CURSOR_ARROW_POINTS.map((p) => p.y)) + half,
  };
  const reach = PARK_CHEVRON_PX / 2 + 0.75;
  const chevron: Rect | null = o.chevron
    ? { left: o.chevron.x - reach, right: o.chevron.x + reach, top: o.chevron.y - reach, bottom: o.chevron.y + reach }
    : null;
  const inset = PARK_LABEL_INSET_PX;
  const slid = (box: Rect, dy: number): { box: Rect; x: number; y: number } => {
    let dx = 0;
    if (box.right > clip.right - inset) dx = clip.right - inset - box.right;
    if (box.left + dx < clip.left + inset) dx = clip.left + inset - box.left;
    return { box: { left: box.left + dx, right: box.right + dx, top: box.top + dy, bottom: box.bottom + dy }, x: dx, y: dy };
  };
  // Tried in order: where it is; above the arrow; below the arrow and the
  // chevron; above both. Each slid sideways to fit the panel.
  const clear = PARK_LABEL_CLEAR_PX;
  const aboveArrow = arrow.top - clear - blockH - home.top;
  const belowAll = Math.max(arrow.bottom, chevron?.bottom ?? -Infinity) + clear - home.top;
  const aboveAll = Math.min(arrow.top, chevron?.top ?? Infinity) - clear - blockH - home.top;
  const candidates = [slid(home, 0), slid(home, aboveArrow), slid(home, belowAll), slid(home, aboveAll)];
  // Where it already is clears the arrow by design (its box and the arrow's overlap by a fraction of a px at the corner).
  const fits = (c: { box: Rect; x: number; y: number }) => c.box.top >= clip.top + inset && c.box.bottom <= clip.bottom - inset
    && (c.x === 0 && c.y === 0 || !overlap(c.box, arrow)) && !(chevron && overlap(c.box, chevron, clear));
  const chosen = candidates.find(fits) ?? candidates[1];
  return { x: chosen.x, y: chosen.y };
}
