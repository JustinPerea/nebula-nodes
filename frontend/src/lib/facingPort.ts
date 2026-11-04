/**
 * The outer edge, on screen, of the dot of the node's outermost port on one
 * side ('right': the largest right edge; 'left': the smallest left edge), or
 * null when it has no port shown there (GM r111: a port is a drag source, so
 * the panel never covers it).
 *
 * The dot is the handle's ::before in the house skin (slava-restraint.css):
 * `--sr-handle-dot-size` wide, centred on the handle and drawn
 * `--sr-handle-rest-offset` toward the card at rest. It is read from layout
 * values (the pseudo's width, the offset token), never its transform, so a
 * hover (the dot fades, the full circle shows) moves nothing. The handle's
 * screen box gives its centre and the zoom (screen width over layout width),
 * so the edge is right at every zoom and moves with the card's edge on its
 * width spring. A handle with no drawn dot (another skin, a test) counts as
 * its whole box.
 */
export function facingPortEdge(anchor: HTMLElement, side: 'left' | 'right'): number | null {
  const node = anchor.closest<HTMLElement>('.react-flow__node') ?? anchor;
  let edge: number | null = null;
  for (const handle of node.querySelectorAll<HTMLElement>(`.react-flow__handle-${side}`)) {
    const box = handle.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    let outer = side === 'right' ? box.right : box.left;
    const dot = parseFloat(window.getComputedStyle(handle, '::before').width);
    if (Number.isFinite(dot) && dot > 0) {
      const zoom = handle.offsetWidth > 0 ? box.width / handle.offsetWidth : 1;
      const rest = parseFloat(window.getComputedStyle(handle).getPropertyValue('--sr-handle-rest-offset')) || 0;
      const centre = box.left + box.width / 2;
      outer = side === 'right' ? centre + (dot / 2 - rest) * zoom : centre - (dot / 2 - rest) * zoom;
    }
    if (edge === null || (side === 'right' ? outer > edge : outer < edge)) edge = outer;
  }
  return edge;
}
