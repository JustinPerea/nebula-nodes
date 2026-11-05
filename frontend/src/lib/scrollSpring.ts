import { springEase, SPRING_SOFT } from './springs';

/**
 * The scroll spring (GM r100.2; the Inspector's "scroll spring, jump under
 * reduced motion" from #208): scroll an element to `top` on SPRING_SOFT
 * (critically damped, so it never overshoots the row it brings into view),
 * or at once when the person asked for reduced motion. Rigid wins: the
 * person's own wheel, touch, pointer or key on the element ends the spring
 * where it is. Returns a stop function; `done` runs once it lands or stops.
 * Only the Message box's chunk imports this.
 */
export function springScrollTo(element: HTMLElement, top: () => number, done?: () => void): () => void {
  const reduce = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const from = element.scrollTop;
  if (reduce || typeof window.requestAnimationFrame !== 'function' || Math.abs(top() - from) < 1) {
    element.scrollTop = top();
    done?.();
    return () => {};
  }
  const { duration, ease } = springEase(SPRING_SOFT);
  let frame = 0;
  let start: number | null = null;
  let over = false;
  const stop = () => {
    if (over) return;
    over = true;
    window.cancelAnimationFrame(frame);
    for (const kind of TAKEOVER) element.removeEventListener(kind, stop);
    done?.();
  };
  for (const kind of TAKEOVER) element.addEventListener(kind, stop, { passive: true });
  const step = (now: number) => {
    if (over) return;
    start ??= now;
    const progress = Math.min(1, (now - start) / (duration * 1000));
    // The target is read each frame: a row that grows meanwhile is still reached.
    element.scrollTop = from + (top() - from) * ease(progress);
    if (progress >= 1) stop();
    else frame = window.requestAnimationFrame(step);
  };
  frame = window.requestAnimationFrame(step);
  return stop;
}

const TAKEOVER = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
