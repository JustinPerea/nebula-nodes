import { AGENT_CURSOR_SPRING, isAtRest, stepSpring, type SpringState } from './agentCursorMotion';
import type { ViewportValue } from './canvasFit';

/** Spring progress runs 0 → SCALE so the cursor spring's rest thresholds (in pixels) mean something. */
const SCALE = 1000;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Move the canvas viewport to `to` on the agent cursor's spring, the same
 * settle the cursor and the proposal ghosts have, since an agent's edit is
 * what moves it. Pan and zoom share one progress value, so the view travels
 * in a straight line. Reduced motion jumps. Returns a cancel function.
 */
export function springViewport(
  from: ViewportValue,
  to: ViewportValue,
  apply: (viewport: ViewportValue) => void,
): () => void {
  if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
    apply(to);
    return () => {};
  }
  let state: SpringState = { x: 0, y: 0, vx: 0, vy: 0 };
  const target = { x: SCALE, y: 0 };
  let last: number | null = null;
  let frame: number | null = null;
  const at = (progress: number): ViewportValue => ({
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
    zoom: from.zoom + (to.zoom - from.zoom) * progress,
  });
  const tick = (time: number) => {
    const dt = last === null ? 1 / 60 : (time - last) / 1000;
    last = time;
    state = stepSpring(state, target, dt, AGENT_CURSOR_SPRING);
    if (isAtRest(state, target)) {
      apply(to);
      frame = null;
      return;
    }
    apply(at(state.x / SCALE));
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
}
