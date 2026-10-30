import { useEffect, useState, type RefObject } from 'react';
import { subscribeOfflinePulse } from '../lib/backendConnection';
/** A blocked edit's pulse on a banner element (the canvas's floating one, a
 * studio's row): a spring nudge, or a colour flash with reduced motion. The
 * animation restarts on the same element, so its live region is never
 * re-added and never announced again. */
export function useOfflinePulse(banner: RefObject<HTMLElement | null>, offline: boolean) {
  const [pulse, setPulse] = useState<{ seq: number; kind: 'spring' | 'flash' } | null>(null);

  useEffect(() => subscribeOfflinePulse(() => {
    const reduce = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setPulse((previous) => ({ seq: (previous?.seq ?? 0) + 1, kind: reduce ? 'flash' : 'spring' }));
  }), []);

  // Restart the animation in place: drop the attribute, reflow, set it again.
  useEffect(() => {
    const element = banner.current;
    if (!element || !pulse) return;
    element.removeAttribute('data-pulse');
    void element.offsetWidth;
    element.setAttribute('data-pulse', pulse.kind);
  }, [banner, pulse]);

  // A pulse belongs to the outage it happened in: none shows once online.
  return offline ? pulse : null;
}
