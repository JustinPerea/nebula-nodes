/** The outside-the-view chip's words and edge (GM - Design, #210 answer 1); OutsideChip draws them. */

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
