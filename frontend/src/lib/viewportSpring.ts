import { AGENT_CURSOR_SPRING, isAtRest, stepSpring, type SpringState } from './agentCursorMotion';
import type { ViewportValue } from './canvasFit';

/** Spring progress runs 0 → SCALE so the cursor spring's rest thresholds (in pixels) mean something. */
const SCALE = 1000;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Run 0 → 1 on the agent cursor's spring (the board camera's spring), calling
 * `apply` with each frame's progress (it may pass 1 a little on the way) and
 * `done` once at rest, after a last `apply(1)`. Reduced motion, or no frames,
 * goes straight to 1. Returns a cancel function (no `done` after it).
 */
export function springProgress(apply: (progress: number) => void, done: () => void = () => {}): () => void {
  if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
    apply(1);
    done();
    return () => {};
  }
  let state: SpringState = { x: 0, y: 0, vx: 0, vy: 0 };
  const target = { x: SCALE, y: 0 };
  let last: number | null = null;
  let frame: number | null = null;
  // A cancel from inside `apply` (a caller that stops on seeing the person
  // move the camera) lands while a frame is running: it must stop the next.
  let stopped = false;
  const tick = (time: number) => {
    if (stopped) return;
    const dt = last === null ? 1 / 60 : (time - last) / 1000;
    last = time;
    state = stepSpring(state, target, dt, AGENT_CURSOR_SPRING);
    if (isAtRest(state, target)) {
      frame = null;
      apply(1);
      done();
      return;
    }
    apply(state.x / SCALE);
    if (stopped) return;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
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
  return springProgress((progress) => apply(progress === 1 ? to : {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
    zoom: from.zoom + (to.zoom - from.zoom) * progress,
  }));
}
