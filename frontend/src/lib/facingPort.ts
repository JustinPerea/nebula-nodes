/** The panel's gap to the outer edge of a port's rest dot (GM r111). */
export const PORT_DOT_CLEARANCE = 8;
/** The panel's gap to the edge of a port's hit target and of its hover circle (GM r114). */
export const PORT_TARGET_CLEARANCE = 2;

/**
 * Where the panel's edge stands, on screen, beside the node's outermost port
 * on one side ('right': the largest edge; 'left': the smallest), or null when
 * it has no port shown there. A port is a drag source, so the panel never
 * covers any part of it (GM r111, r114): the edge is the farthest of
 *   - the rest dot's outer edge + 8,
 *   - the handle's hit target (its box) + 2,
 *   - the hover circle's outer edge + 2 (the full glass circle that shows on
 *     hover or while a wire is dragged, with its border and the magnet's
 *     offset).
 * The target and the circle are 20 px in the house skin, so past 100 % zoom
 * they reach further out than the dot, and the panel stands further out too.
 *
 * Every size is read from the skin's own boxes (the pseudos' computed width,
 * border and box-sizing, the offset tokens), never a constant and never a
 * transform, so a hover moves nothing and another skin gets its own. The
 * handle's screen box gives its centre and the zoom (screen width over layout
 * width), so the edge is right at every zoom and moves with the card's edge on
 * its width spring. A handle with no drawn dot or circle (another skin, a
 * test) counts as its whole box.
 */
export function facingPortEdge(anchor: HTMLElement, side: 'left' | 'right'): number | null {
  const node = anchor.closest<HTMLElement>('.react-flow__node') ?? anchor;
  const sign = side === 'right' ? 1 : -1;
  let edge: number | null = null;
  for (const handle of node.querySelectorAll<HTMLElement>(`.react-flow__handle-${side}`)) {
    const box = handle.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const zoom = handle.offsetWidth > 0 ? box.width / handle.offsetWidth : 1;
    const centre = box.left + box.width / 2;
    const style = window.getComputedStyle(handle);
    // The hit target.
    let outer = (side === 'right' ? box.right : box.left) + sign * PORT_TARGET_CLEARANCE;
    // The hover circle: its own width (with its border when the box doesn't
    // count it), drawn at the handle's centre, offset by the magnet.
    const circle = window.getComputedStyle(handle, '::after');
    const circleWidth = parseFloat(circle.width);
    if (Number.isFinite(circleWidth) && circleWidth > 0) {
      const border = circle.boxSizing === 'border-box' ? 0 : (parseFloat(circle.borderLeftWidth) || 0) * 2;
      const magnet = parseFloat(style.getPropertyValue('--sr-handle-magnet-x')) || 0;
      const circleEdge = centre + (magnet + sign * (circleWidth + border) / 2) * zoom + sign * PORT_TARGET_CLEARANCE;
      outer = side === 'right' ? Math.max(outer, circleEdge) : Math.min(outer, circleEdge);
    }
    // The rest dot.
    const dot = parseFloat(window.getComputedStyle(handle, '::before').width);
    if (Number.isFinite(dot) && dot > 0) {
      const rest = parseFloat(style.getPropertyValue('--sr-handle-rest-offset')) || 0;
      const dotEdge = centre + sign * (dot / 2 - rest) * zoom + sign * PORT_DOT_CLEARANCE;
      outer = side === 'right' ? Math.max(outer, dotEdge) : Math.min(outer, dotEdge);
    } else {
      // No drawn dot: the whole box, at the dot's gap.
      const boxEdge = (side === 'right' ? box.right : box.left) + sign * PORT_DOT_CLEARANCE;
      outer = side === 'right' ? Math.max(outer, boxEdge) : Math.min(outer, boxEdge);
    }
    if (edge === null || (side === 'right' ? outer > edge : outer < edge)) edge = outer;
  }
  return edge;
}
