import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { hasMoreBelow } from '../../lib/hasMoreBelow';

/**
 * The proposal bar's details (GM, PR #203 r28): a box of its own above the
 * button row, with its own rounded border, that scrolls inside. A 24 px fade
 * at its bottom says there's more below, wherever the cut falls (between two
 * lines too, where nothing looks cut), and goes at the end of the scroll.
 * It is a focusable region named "Details" with the shared focus ring, so a
 * keyboard can scroll it. The scrollbar stays visible: the fade covers the
 * content, never the scrollbar.
 */
export function DetailsBox({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    if (box.current) setMore(hasMoreBelow(box.current));
  }, []);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    // The box or what it holds changing size (a wider window, a line added).
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  });
  return (
    <div
      ref={box}
      className="proposal-bar__details"
      role="region"
      aria-label="Details"
      tabIndex={0}
      data-more={more || undefined}
      onScroll={measure}
    >
      {children}
      <div className="proposal-bar__details-fade" aria-hidden="true" />
    </div>
  );
}
