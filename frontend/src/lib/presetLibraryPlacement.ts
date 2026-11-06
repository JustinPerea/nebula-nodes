import { floatingBottomLimit, floatingTopLimit } from './bottomBar';

/** The window's edge the picker keeps clear of, as the floating panels do. */
const GUTTER = 16;

/**
 * Where Styles sits (GM r8, 2 on PR #204: Creator Studio's notice region stays
 * at the bottom, just above the composer, and a notice never lands on the
 * content of the popover the person is using). Styles stops above the
 * region's reserved band like every floating panel (lib/bottomBar.ts
 * floatingBottomLimit), so its "because" line under a refused Save shows
 * beneath the picker, not over its cards. Its bottom is measured from the
 * window's bottom edge (.create-view is fixed to the window), its height
 * capped by the header's line.
 */
export function presetLibraryPlacement(viewportHeight = window.innerHeight): { bottom: number; maxHeight: number } {
  const limit = floatingBottomLimit(GUTTER, viewportHeight);
  const top = floatingTopLimit(GUTTER);
  return { bottom: Math.max(GUTTER, Math.round(viewportHeight - limit)), maxHeight: Math.max(160, Math.round(Math.min(viewportHeight * 0.6, limit - top))) };
}
