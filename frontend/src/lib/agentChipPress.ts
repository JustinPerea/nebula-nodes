import type { Box, Point } from './agentAnchorResolve';
import type { ViewportValue } from './canvasFit';
import { springViewport } from './viewportSpring';

/**
 * The edge chip's press (PR #233 slice 9): the one place the cursor code pans
 * the canvas, and only because the person pressed the chip. It springs the
 * camera, at the zoom it has, to centre the cursor's target in the visible
 * pane. tests/agentCursorNoOpen.test.ts scans the rest of the chunk for any
 * other pan, scroll or fit; this file is its single allowed exception
 * (PRESS_HANDLERS). In the cursor chunk (lib/deferredChunks.ts DEFERRED_MODULES).
 */
export function panToTarget({ target, view, pane, store }: {
  /** The cursor's target in flow coordinates. */
  target: Point;
  /** The visible pane (client px) and the canvas's own box. */
  view: Box;
  pane: Box;
  /** React Flow's store: its camera and its pan and zoom. */
  store: { getState(): { transform?: readonly number[]; panZoom?: { setViewport(viewport: ViewportValue): unknown } | null } };
}): (() => void) | null {
  const { transform, panZoom } = store.getState();
  if (!transform || !panZoom) return null;
  const viewport: ViewportValue = { x: transform[0], y: transform[1], zoom: transform[2] };
  const to: ViewportValue = {
    zoom: viewport.zoom,
    x: view.left + view.width / 2 - pane.left - target.x * viewport.zoom,
    y: view.top + view.height / 2 - pane.top - target.y * viewport.zoom,
  };
  return springViewport(viewport, to, (next) => { void panZoom.setViewport(next); });
}
