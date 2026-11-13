import type { Point } from './agentCursorMotion';
import { AGENT_CURSOR_ARROW_POINTS, AGENT_CURSOR_ARROW_STROKE, AGENT_CURSOR_ARROW_TIP } from './agentCursorLook';

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
