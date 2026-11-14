import type { AgentCursorAnchor } from './wsClient';

/**
 * Which layer draws a cursor (Phase 3, "Anywhere"; plan section 3). The
 * canvas layer draws cursors on the canvas, in flow space; the screen layer
 * draws the rest, in client pixels. Both filter the one presence store by
 * this, so no cursor is drawn twice and none is dropped:
 *  - a surface target (a moodboard item) is always the screen layer's;
 *  - a canvas target (a node, a port, a spot) is the canvas layer's while the
 *    canvas is mounted, and the screen layer's when it is not (a Moodboard
 *    Studio replaced it: the cursor parks at "Back to Canvas").
 *
 * In the cursor chunk (lib/deferredChunks.ts DEFERRED_MODULES).
 */
export type CursorLayer = 'canvas' | 'screen';

export function layerOf(anchor: AgentCursorAnchor, { canvasMounted }: { canvasMounted: boolean }): CursorLayer {
  if ('surface' in anchor) return 'screen';
  return canvasMounted ? 'canvas' : 'screen';
}
