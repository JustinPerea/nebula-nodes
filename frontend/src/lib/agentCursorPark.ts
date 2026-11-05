import type { Point } from './agentCursorMotion';
import { AGENT_CURSOR_ARROW_POINTS, AGENT_CURSOR_ARROW_TIP } from './agentCursorLook';

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
 *  direction that leaves it at once (up or left of the tip). */
export function arrowExitPx(angle: number): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  if (dx < 0 || dy < 0) return 0;
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
