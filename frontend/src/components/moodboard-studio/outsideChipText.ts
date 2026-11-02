/** The outside-the-view chip's words, edge and when it goes (GM - Design, #210 answers); OutsideChip draws them. */

import type { NodeRect } from '../../lib/nodePlacement';
import { insideView } from '../../lib/boardPlacement';

export type ChipEdge = 'left' | 'right' | 'top' | 'bottom';

/** The chip's words (GM, #210 answer 1). */
export function outsideChipText(count: number): { text: string; label: string } {
  return count === 1
    ? { text: 'Added outside the view', label: 'Added outside the view, show it' }
    : { text: `${count} images added outside the view`, label: `${count} images added outside the view, show them` };
}

/** The view's edge nearest a point given in screen pixels of a `width` x `height` board. */
export function nearestEdge(point: { x: number; y: number }, width: number, height: number): ChipEdge {
  const dx = (point.x - width / 2) / (width / 2 || 1);
  const dy = (point.y - height / 2) / (height / 2 || 1);
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'top' : 'bottom';
}

/** A tile is plainly seen when it is wholly in view, or (only one bigger
 *  than the view, which can never be wholly in it) when it covers the view's
 *  centre (GM r4 answer 9, r7 answer 1). Any other tile is either wholly in
 *  view or, for the chip, still outside it. */
export const seenIn = (rect: NodeRect, view: NodeRect) => {
  if (insideView(rect, view)) return true;
  if (rect.width <= view.width && rect.height <= view.height) return false;
  const cx = view.x + view.width / 2;
  const cy = view.y + view.height / 2;
  return rect.x <= cx && cx <= rect.x + rect.width && rect.y <= cy && cy <= rect.y + rect.height;
};
