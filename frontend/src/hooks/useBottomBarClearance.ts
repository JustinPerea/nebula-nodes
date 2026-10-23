import { useLayoutEffect, type RefObject } from 'react';
import { clearBottomBarClearance, publishBottomBarClearance } from '../lib/bottomBar';

/**
 * A screen's bottom bar publishes where it starts (lib/bottomBar.ts), for the
 * notices that sit 8 px above it and the floating panels that end above it:
 * the canvas's bar with its open Canvas actions panel, Creator Studio's
 * composer (GM - Design, 2026-10-23: "the composer publishes its top edge the
 * way the canvas bar does"), the Remotion editor's timeline tray (round 3:
 * "Yes, the Remotion tray publishes its top edge, the same as the canvas bar
 * and the composer.") and the trim editor's timeline (round 4: "A notice
 * should never sit over a timeline being edited, even one that shares its
 * column."). Each part carries `data-bottom-bar`. Measured
 * again whenever a part or the window changes size, and whenever `key`
 * changes (a part mounting, such as the actions panel opening); cleared when
 * the bar leaves the screen.
 */
export function useBottomBarClearance(parts: ReadonlyArray<RefObject<HTMLElement | null>>, key?: unknown): void {
  useLayoutEffect(() => {
    publishBottomBarClearance();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publishBottomBarClearance) : null;
    for (const part of parts) if (part.current) observer?.observe(part.current);
    window.addEventListener('resize', publishBottomBarClearance);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', publishBottomBarClearance);
    };
    // `parts` are refs (stable); `key` says when a part came or went.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useLayoutEffect(() => clearBottomBarClearance, []);
}
