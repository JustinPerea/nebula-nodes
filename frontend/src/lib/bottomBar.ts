/**
 * Where the canvas's bottom bar (Run / Canvas actions / zoom) really starts,
 * for what must keep clear of it: the app's notices sit just above it, and a
 * floating panel opened beside a node low on the screen ends above it (GM -
 * Design, 2026-10-23: "Clamp it so it stays above the bottom bar inside the
 * viewport"). Measured, never a fixed number: the bar's height changes with
 * its contents, and its Canvas actions panel opens above it.
 *
 * Every box that belongs to the bar carries `data-bottom-bar`: the bar itself
 * (empty value) and, while open, its Canvas actions panel (`"panel"`). The
 * bar is a band across the whole width: nothing floats down beside it. The
 * panel is 310 px wide and centred, so it only pushes up what it is under
 * (review, 2026-10-23: a far-left Inspector jumped 400 px off its node when
 * the panel opened). The bar publishes the distance from the window's bottom
 * edge to its top, panel included, as `--bottom-bar-clearance` on the root,
 * which the notice region's CSS reads (canvasProposals.css): the notices are
 * centred, so they always clear the panel.
 */
export const BOTTOM_BAR_ATTR = 'data-bottom-bar';
/** The `data-bottom-bar` value on a part that covers only its own width (the Canvas actions panel). */
export const BOTTOM_BAR_PANEL = 'panel';
export const BOTTOM_BAR_CLEARANCE_VAR = '--bottom-bar-clearance';

/** The gap a floating panel keeps above the bar (the notices' too, in CSS: --sr-space-2). */
export const BOTTOM_BAR_GAP = 8;

/** A horizontal stretch of the window, in viewport px. */
export type HorizontalSpan = { left: number; right: number };

/**
 * The top edge of the bar and its open panel, or null when no bar is on
 * screen. With `span`, the panel counts only where it overlaps that stretch;
 * the bar always counts.
 */
export function bottomBarTop(span?: HorizontalSpan): number | null {
  if (typeof document === 'undefined') return null;
  let top: number | null = null;
  for (const part of document.querySelectorAll<HTMLElement>(`[${BOTTOM_BAR_ATTR}]`)) {
    const box = part.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    if (span && part.getAttribute(BOTTOM_BAR_ATTR) === BOTTOM_BAR_PANEL
      && (box.right <= span.left || box.left >= span.right)) continue;
    top = top === null ? box.top : Math.min(top, box.top);
  }
  return top;
}

/**
 * The lowest a floating panel's bottom edge may go: `gutter` above the
 * window's bottom edge, and above the bar (with its gap) when there is one.
 * Pass the panel's own `span` so the Canvas actions panel pushes it up only
 * when it would be over it.
 */
export function floatingBottomLimit(gutter: number, viewportHeight = window.innerHeight, span?: HorizontalSpan): number {
  const edge = viewportHeight - gutter;
  const bar = bottomBarTop(span);
  return bar === null ? edge : Math.min(edge, bar - BOTTOM_BAR_GAP);
}

/** Writes the bar's clearance on the root (or clears it when no bar is on screen). */
export function publishBottomBarClearance(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const top = bottomBarTop();
  if (top === null) root.style.removeProperty(BOTTOM_BAR_CLEARANCE_VAR);
  else root.style.setProperty(BOTTOM_BAR_CLEARANCE_VAR, `${Math.max(0, Math.round(window.innerHeight - top))}px`);
}

export function clearBottomBarClearance(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.removeProperty(BOTTOM_BAR_CLEARANCE_VAR);
}
