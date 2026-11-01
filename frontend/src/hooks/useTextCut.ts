import { useEffect, useState, type RefObject } from 'react';

/**
 * Whether one line of text is cut with an ellipsis (its content wider than
 * its box), measured whenever the box resizes or the text changes. A cut
 * studio title gets its full text as a tooltip (#213 round 3, review 1
 * NIT-6); a whole one needs none.
 */
export function useTextCut(ref: RefObject<HTMLElement | null>, text: string): boolean {
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => setCut(element.scrollWidth > element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, text]);
  return cut;
}
