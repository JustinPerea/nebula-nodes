import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * GM r6 on #208, item 4: "The brief holds its place ... clearing the line must
 * not move what's above it. When clearing the line would shorten a panel
 * scrolled to the bottom, put a bottom spacer of the removed height in its
 * place. The spacer collapses on the person's next scroll, or when the
 * panel's content next changes. No jump, and no automatic scroll."
 *
 * Render the returned ref on an element that is the last child of the
 * scrolling panel (`<div ref={ref} className="moodboard-hold-spacer" aria-hidden="true" />`).
 * The panel is that element's parent. Lines matching `selector` (the
 * "old colors" lines) are watched; when a commit removes one and the shorter
 * content would pull the panel's scrollTop down (the browser clamps it to the
 * new bottom), the spacer takes the missing height before paint, so nothing
 * on screen moves. It is shown and sized through a data attribute and a CSS
 * variable (no React style prop), so React's renders leave it alone.
 *
 * Runs only while such a line is on screen: with none there is nothing to
 * measure and no layout read.
 */
export const HOLD_HEIGHT_VAR = '--moodboard-hold-h';
const HOLDING = 'holding';

export function useHoldBottom(selector: string) {
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const state = useRef({
    panel: null as HTMLElement | null,
    /** The watched lines seen last, with their height (margins included). */
    lines: new Map<Element, number>(),
    /** The panel's scrollTop as of the last scroll or commit. */
    top: 0,
    /** While a spacer holds: the scrollTop it keeps, and how it ends. */
    hold: null as null | { top: number; observer: MutationObserver | null },
    onScroll: null as null | (() => void),
  });

  const collapse = () => {
    const s = state.current;
    const spacer = spacerRef.current;
    s.hold?.observer?.disconnect();
    s.hold = null;
    if (spacer) {
      delete spacer.dataset[HOLDING];
      spacer.style.removeProperty(HOLD_HEIGHT_VAR);
    }
  };

  // Every commit of the panel's owner (no deps on purpose).
  useLayoutEffect(() => {
    const s = state.current;
    const spacer = spacerRef.current;
    const panel = spacer?.parentElement ?? null;
    if (panel !== s.panel) {
      if (s.panel && s.onScroll) s.panel.removeEventListener('scroll', s.onScroll);
      collapse();
      s.lines.clear();
      s.panel = panel;
      s.onScroll = null;
      if (panel) {
        const onScroll = () => {
          const hold = s.hold;
          // The person scrolled: a scroll that leaves the held position (one
          // that doesn't is the browser's own, never the person's).
          if (hold && panel.scrollTop !== hold.top) collapse();
          s.top = panel.scrollTop;
          for (const line of s.lines.keys()) s.lines.set(line, lineHeight(line));
        };
        panel.addEventListener('scroll', onScroll, { passive: true });
        s.onScroll = onScroll;
        s.top = panel.scrollTop;
      }
    }
    if (!panel || !spacer) return;

    let removed = 0;
    for (const [line, height] of s.lines) {
      if (!line.isConnected || !panel.contains(line)) {
        removed += height;
        s.lines.delete(line);
      }
    }
    if (removed > 0 && !s.hold) holdPlace(panel, spacer, removed);
    for (const line of panel.querySelectorAll(selector)) {
      if (!s.lines.has(line)) s.lines.set(line, lineHeight(line));
    }

    function holdPlace(scroller: HTMLElement, el: HTMLDivElement, estimate: number) {
      const top = s.top;
      // The content height that keeps scrollTop where it was.
      const want = top + scroller.clientHeight;
      el.dataset[HOLDING] = '';
      el.style.setProperty(HOLD_HEIGHT_VAR, `${estimate}px`);
      const deficit = want - (scroller.scrollHeight - estimate);
      const gap = parseFloat(getComputedStyle(scroller).rowGap) || 0;
      if (top <= 0 || deficit + gap <= 0) {
        // Not shortened past the bottom: nothing would move, so no spacer.
        delete el.dataset[HOLDING];
        el.style.removeProperty(HOLD_HEIGHT_VAR);
        return;
      }
      el.style.setProperty(HOLD_HEIGHT_VAR, `${Math.max(0, deficit)}px`);
      // A layout read above may already have clamped it; put it back where it
      // was (same place, so nothing moves and it isn't the person's scroll).
      if (scroller.scrollTop !== top) scroller.scrollTop = top;
      const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(collapse);
      // Content changes from here on (this commit's are already done).
      observer?.observe(scroller, { childList: true, subtree: true, characterData: true });
      s.hold = { top, observer };
    }
  });

  useEffect(() => () => {
    const s = state.current;
    if (s.panel && s.onScroll) s.panel.removeEventListener('scroll', s.onScroll);
    s.hold?.observer?.disconnect();
  }, []);

  return spacerRef;
}

function lineHeight(line: Element): number {
  const style = getComputedStyle(line);
  return line.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
}
