import { useLayoutEffect, useState, type CSSProperties } from 'react';
import { BOTTOM_BAR_ATTR, floatingBottomLimit } from '../lib/bottomBar';
import { useCappedPopover } from '../lib/noticeWaiting';

/** The window's edge a modal keeps clear of, as the floating panels do. */
const GUTTER = 16;

/**
 * How far above the window's bottom edge a modal's box must stop so a notice never lands on it
 * (review 6 MEDIUM-3, GM r11 answer 3: "capped like Styles"). The same line Styles and every
 * floating panel stop at (lib/bottomBar.ts floatingBottomLimit): above the bar and the notice
 * region's reserved band, shown or not, so the box never moves when a notice comes or goes.
 */
export function noticeClearance(viewportHeight = window.innerHeight): number {
  return Math.max(GUTTER, Math.round(viewportHeight - floatingBottomLimit(GUTTER, viewportHeight)));
}

/**
 * `--notice-clearance` for a modal's overlay (the model picker, the Lightbox, the comparison):
 * its stylesheet pads its bottom by at least that and caps its box's height to match. Measured
 * again when a bar (the composer) or the window changes size. While it is mounted the band
 * shows only the newest notice (GM r13 2, lib/noticeWaiting), so one notice never lands on the
 * box.
 */
export function useNoticeClearance(): CSSProperties {
  useCappedPopover();
  const [clearance, setClearance] = useState(() => noticeClearance());
  useLayoutEffect(() => {
    const measure = () => setClearance(noticeClearance());
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    for (const bar of document.querySelectorAll(`[${BOTTOM_BAR_ATTR}]`)) observer?.observe(bar);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  return { '--notice-clearance': `${clearance}px` } as CSSProperties;
}
