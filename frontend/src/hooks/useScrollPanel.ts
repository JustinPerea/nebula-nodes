import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * A panel that scrolls inside itself only at some sizes (the Board view's
 * side panel, under the board in a narrow window, #213 round 3):
 * - while its content overflows it is a tab stop, so the keyboard can scroll
 *   it (it holds text that no control scrolls into view), and returns
 *   `scrolls` for the caller's tabIndex;
 * - its scroll position is kept across a size where nothing overflows: the
 *   browser drops it to 0 there (the panel beside the board at 970 px), and
 *   it comes back when the panel scrolls again (under it at 969 px).
 */
export function useScrollPanel(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolls, setScrolls] = useState(false);
  const kept = useRef(0);
  useEffect(() => {
    const panel = ref.current;
    if (!panel) return undefined;
    const overflows = () => panel.scrollHeight - panel.clientHeight > 1;
    const measure = () => {
      const now = overflows();
      setScrolls(now);
      if (now && kept.current > 0 && panel.scrollTop !== kept.current) panel.scrollTop = kept.current;
    };
    // Only a position the person could scroll to is kept: the browser's own
    // drop to 0 where nothing overflows isn't theirs.
    const onScroll = () => {
      if (overflows()) kept.current = panel.scrollTop;
    };
    measure();
    panel.addEventListener('scroll', onScroll, { passive: true });
    // The panel's size (the crossing, a window resize), and its content (a
    // card selected, a note's field growing).
    const sized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    sized?.observe(panel);
    const changed = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure);
    changed?.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    return () => {
      panel.removeEventListener('scroll', onScroll);
      sized?.disconnect();
      changed?.disconnect();
    };
  }, [ref]);
  return scrolls;
}
