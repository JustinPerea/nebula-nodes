import { useEffect, useState, type RefObject } from 'react';

/**
 * Whether one line of text is cut with an ellipsis (its content wider than
 * its box), measured whenever the box resizes or the text changes. A cut
 * studio title gets its full text as a tooltip (#213 round 3, review 1
 * NIT-6); a whole one needs none. A screen-reader-only title is never
 * seen, so the caller gives it no tooltip.
 */
export function useTextCut(ref: RefObject<HTMLElement | null>, text: string): boolean {
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    let live = true;
    const measure = () => {
      if (live) setCut(element.scrollWidth > element.clientWidth);
    };
    measure();
    // The web font arriving widens or narrows the text without resizing its
    // box (#213 round 3c): measure again once it has loaded.
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    void fonts?.ready.then(measure);
    fonts?.addEventListener?.('loadingdone', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      live = false;
      fonts?.removeEventListener?.('loadingdone', measure);
      observer?.disconnect();
    };
  }, [ref, text]);
  return cut;
}
