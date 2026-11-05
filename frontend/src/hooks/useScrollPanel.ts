import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * A panel that scrolls inside itself only at some sizes (the Board view's
 * side panel, under the board in a narrow window, #213 round 3):
 * - while its content overflows it is a tab stop, so the keyboard can scroll
 *   it (it holds text that no control scrolls into view), and returns
 *   `scrolls` for the caller's tabIndex;
 * - its scroll position follows the person (#213 round 3c): where they
 *   scrolled it is the intent, kept across a size that can't reach it. Beside
 *   the board at 970 px nothing overflows and the browser drops it to 0; under
 *   a short board it can reach only so far (55 of 120) and sits there; once
 *   the intent is reachable again (under it at 969 px, or taller) it goes back.
 *   A scroll the person makes anywhere, clamped or not, is the new intent.
 */
export function useScrollPanel(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolls, setScrolls] = useState(false);
  const intent = useRef(0);
  useEffect(() => {
    const panel = ref.current;
    if (!panel) return undefined;
    const reach = () => Math.max(0, panel.scrollHeight - panel.clientHeight);
    /** Where the intent puts the panel at its size now: as far toward it as it can go. */
    const target = () => Math.min(intent.current, reach());
    const measure = () => {
      setScrolls(reach() > 1);
      const to = target();
      if (Math.abs(panel.scrollTop - to) >= 1) panel.scrollTop = to;
    };
    // The app's own moves land on the target (the browser's clamp or drop to
    // 0 at a size change, and measure's restore): those aren't the person's.
    // Any other position is a scroll they made.
    const onScroll = () => {
      if (Math.abs(panel.scrollTop - target()) >= 1) intent.current = panel.scrollTop;
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
