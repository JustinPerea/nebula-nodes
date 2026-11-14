import type { Box, Point } from './agentAnchorResolve';
import type { ViewportValue } from './canvasFit';
import { canvasFocusTarget } from './noticeFocus';
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
  // The spring writes absolute viewports, so a person's own pan or zoom in
  // its ~400 ms (a wheel, a drag, a key, a zoom button) would be written over
  // on the next frame. The camera is read before each write: if it is not
  // where the last frame left it, the person moved it, and the spring stops.
  let written = viewport;
  let cancel: (() => void) | null = null;
  cancel = springViewport(viewport, to, (next) => {
    const now = store.getState().transform;
    if (now && (Math.abs(now[0] - written.x) > 0.5 || Math.abs(now[1] - written.y) > 0.5 || Math.abs(now[2] - written.zoom) > 0.001)) {
      cancel?.();
      return;
    }
    written = next;
    void panZoom.setViewport(next);
  });
  return cancel;
}

/**
 * A chip the person pressed goes when its cursor comes into view; focus
 * would fall to the page with it. It goes to the canvas instead (the notice
 * stack's last stop), unless the chip is still in `keep` (its keys). The
 * person's own keyboard use, so it may focus (PRESS_HANDLERS).
 */
export function leaveChipFocus(keep: ReadonlySet<string>, root: Document = document): void {
  const active = root.activeElement;
  if (!(active instanceof HTMLElement) || !active.classList.contains('agent-edge-chip')) return;
  if (keep.has(active.dataset.chipKey ?? '')) return;
  canvasFocusTarget()?.focus({ preventScroll: true });
}
