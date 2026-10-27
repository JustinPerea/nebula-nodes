import { useLayoutEffect, useRef } from 'react';

/** Where the open screen's header ends, in px from the top of the window:
 * the offline banner sits 8px under it on every studio screen (GM, PR #198
 * r1 item 5; App.css `[data-placement='studio']`). */
export const HEADER_BOTTOM_VAR = '--workspace-header-bottom';

/** Publish this header's bottom edge while it is mounted, again whenever it
 * changes size (it wraps at narrow widths). One screen shows at a time, so
 * one header publishes. A screen with its own header (the brand showcase)
 * uses it too. */
export function usePublishedHeaderBottom<T extends HTMLElement = HTMLElement>() {
  const header = useRef<T>(null);
  useLayoutEffect(() => {
    const element = header.current;
    if (!element) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty(HEADER_BOTTOM_VAR, `${Math.round(element.getBoundingClientRect().bottom)}px`);
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(HEADER_BOTTOM_VAR);
    };
  }, []);
  return header;
}
