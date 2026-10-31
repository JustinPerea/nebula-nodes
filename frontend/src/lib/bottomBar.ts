import { subscribeBackendConnection } from './backendConnection';
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
 * The notice region's reserved band (GM - Design, 2026-10-23: "Floating
 * panels stop above a reserved notice band, whether or not a notice is
 * showing. The band is the region's height for one notice plus its gap,
 * measured like the bottom line."). The region always keeps an empty box
 * marked `data-notice-band`, as tall as one notice plus its gap (both read
 * the region's `--notice-h` and `--notice-gap`), its foot on the notices'
 * bottom line. Its box, or null when no region is on screen.
 */
export const NOTICE_BAND_ATTR = 'data-notice-band';

function noticeBand(): DOMRect | null {
  if (typeof document === 'undefined') return null;
  const band = document.querySelector<HTMLElement>(`[${NOTICE_BAND_ATTR}]`)?.getBoundingClientRect();
  return band && band.height > 0 ? band : null;
}

/**
 * The lowest a floating panel's bottom edge may go: `gutter` above the
 * window's bottom edge, above the bar (with its gap) when there is one, and
 * above the notice region's reserved band, shown or not, so a notice never
 * covers a panel's foot row and a panel never moves when a notice comes or
 * goes. Pass the panel's own `span` so the Canvas actions panel pushes it up
 * only when it would be over it: the band then stands on the line the panel
 * sees (the region itself lifts over the centred actions panel, which a panel
 * off to the side never meets).
 */
export function floatingBottomLimit(gutter: number, viewportHeight = window.innerHeight, span?: HorizontalSpan): number {
  const edge = viewportHeight - gutter;
  const bar = bottomBarTop(span);
  const band = noticeBand();
  if (bar === null) return band ? Math.min(edge, band.top) : edge;
  return Math.min(edge, bar - BOTTOM_BAR_GAP - (band?.height ?? 0));
}

/**
 * The top line floating panels stop below (GM - Design, 2026-10-23: "Floating
 * panels stop below the workspace header and the selection toolbar, whichever
 * is lower, plus the same 8 px gap."). Each carries `data-top-bar`; measured
 * when asked, so a resize moves the line. With neither on screen, the
 * window's `gutter`.
 *
 * Round 3 (GM: "The Inspector jumping on deselect: hold it. A panel
 * shouldn't move unless someone moves it. While it's open, use the lower of
 * the two top lines (the toolbar's) whether or not the toolbar is showing."):
 * the toolbar's marker is its React Flow Panel, which keeps the toolbar's
 * height while it is empty (canvas.css --selection-toolbar-h). An empty Panel
 * has no width, so a part counts by its height alone: the toolbar going or
 * coming back never moves the line.
 */
export const TOP_BAR_ATTR = 'data-top-bar';

export function floatingTopLimit(gutter: number): number {
  if (typeof document === 'undefined') return gutter;
  let line = gutter;
  for (const part of document.querySelectorAll<HTMLElement>(`[${TOP_BAR_ATTR}]`)) {
    const box = part.getBoundingClientRect();
    if (box.height <= 0) continue;
    line = Math.max(line, box.bottom + BOTTOM_BAR_GAP);
  }
  return line;
}

/**
 * On the root while a bar comes or goes: a screen switch (back to the canvas
 * from a Studio, into Creator Studio). The notice region then jumps to its
 * new line (noticeRegion.css) instead of springing there: springing up from
 * where it sits with no bar, a notice showing crossed the bar that had just
 * arrived and covered Canvas actions and the zoom for the length of the spring
 * (GM - Design, round 7, the r6-zz-error-cinema.png question). The bar
 * growing (its Canvas actions panel opening) keeps the spring.
 */
export const BOTTOM_BAR_SWITCH_ATTR = 'data-bottom-bar-switch';

let switchFrame: number | null = null;

/** Marks the root for this frame and the next, so the new line is styled without the spring. */
function markBarSwitch(root: HTMLElement): void {
  root.setAttribute(BOTTOM_BAR_SWITCH_ATTR, '');
  if (switchFrame !== null) cancelAnimationFrame(switchFrame);
  switchFrame = requestAnimationFrame(() => {
    switchFrame = requestAnimationFrame(() => {
      switchFrame = null;
      root.removeAttribute(BOTTOM_BAR_SWITCH_ATTR);
    });
  });
}

/** Writes the bar's clearance on the root (or clears it when no bar is on screen). */
export function publishBottomBarClearance(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const before = root.style.getPropertyValue(BOTTOM_BAR_CLEARANCE_VAR);
  const top = bottomBarTop();
  const next = top === null ? '' : `${Math.max(0, Math.round(window.innerHeight - top))}px`;
  if ((before === '') !== (next === '')) markBarSwitch(root);
  if (next === '') root.style.removeProperty(BOTTOM_BAR_CLEARANCE_VAR);
  else root.style.setProperty(BOTTOM_BAR_CLEARANCE_VAR, next);
}

export function clearBottomBarClearance(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.style.getPropertyValue(BOTTOM_BAR_CLEARANCE_VAR) !== '') markBarSwitch(root);
  root.style.removeProperty(BOTTOM_BAR_CLEARANCE_VAR);
}

/**
 * GM r9 item 2 (PR #203 round 6): the notice stack and the top bars (the
 * canvas tabs with the following bar, the selection toolbar's line) never
 * overlap. The region stands on its bottom line and grows up, the proposal
 * bar first in it (lib/noticeSlots.ts), so the stack's room is from that line
 * up to the top bars' line (floatingTopLimit, the line floating panels stop
 * below). The region writes it as `--notice-room` (noticeRegion.css caps the
 * stack's height with it); when the notices outgrow it, the region is marked
 * `data-notice-crowded` and the stack scrolls instead of reaching the bars.
 * Measured whenever the stack, a top bar, the window or the bottom bar's
 * clearance changes. Returns a stop function.
 */
export const NOTICE_ROOM_VAR = '--notice-room';

/** The line under the offline banner (App.css .backend-connection, fixed at
 * 150 px, the selection toolbar's line plus 8, on the 10000 layer), or 0
 * while it isn't shown. A crowded stack stops below it, so the banner never
 * draws over the proposal bar's top row (PR #203 round 6 review, NIT-4). */
export function offlineBannerLine(): number {
  if (typeof document === 'undefined') return 0;
  const box = document.querySelector('.backend-connection')?.getBoundingClientRect();
  return box && box.height > 0 ? box.bottom + BOTTOM_BAR_GAP : 0;
}
export const NOTICE_CROWDED_ATTR = 'data-notice-crowded';
/** The window gutter the stack keeps with no top bar on screen (the region's --page-gutter). */
const NOTICE_TOP_GUTTER = 16;

export function keepNoticesBelowTopBars(region: HTMLElement): () => void {
  if (typeof window === 'undefined') return () => {};
  const stack = region.querySelector<HTMLElement>('.notice-region__stack');
  if (!stack) return () => {};
  const watched = new WeakSet<Element>();
  const resizes = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null;
  const measure = () => {
    // The top bars, and each item (the stack's own box stops growing at the
    // cap, so an item growing past it is seen on the item).
    for (const part of document.querySelectorAll(`[${TOP_BAR_ATTR}], .notice-region__slot > *`)) {
      if (watched.has(part)) continue;
      watched.add(part);
      resizes?.observe(part);
    }
    const bottom = region.getBoundingClientRect().bottom;
    const room = Math.max(0, Math.floor(bottom - Math.max(floatingTopLimit(NOTICE_TOP_GUTTER), offlineBannerLine())));
    const value = `${room}px`;
    if (region.style.getPropertyValue(NOTICE_ROOM_VAR) !== value) region.style.setProperty(NOTICE_ROOM_VAR, value);
    // Its content's own height, whatever the cap: more than the room is crowded.
    const crowded = stack.scrollHeight > room + 1;
    if (crowded !== region.hasAttribute(NOTICE_CROWDED_ATTR)) region.toggleAttribute(NOTICE_CROWDED_ATTR, crowded);
  };
  resizes?.observe(stack);
  // An item coming or going.
  const items = new MutationObserver(measure);
  items.observe(stack, { childList: true, subtree: true });
  // The bottom bar's clearance moves the region's line (it lives on the root's style).
  const clearance = new MutationObserver(measure);
  clearance.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  window.addEventListener('resize', measure);
  region.addEventListener('transitionend', measure);
  // The offline banner comes and goes with the connection: measure once it
  // has rendered (or left).
  let bannerFrame: number | null = null;
  const stopBanner = subscribeBackendConnection(() => {
    if (bannerFrame !== null) cancelAnimationFrame(bannerFrame);
    bannerFrame = requestAnimationFrame(() => { bannerFrame = null; measure(); });
  });
  measure();
  return () => {
    stopBanner();
    if (bannerFrame !== null) cancelAnimationFrame(bannerFrame);
    resizes?.disconnect();
    items.disconnect();
    clearance.disconnect();
    window.removeEventListener('resize', measure);
    region.removeEventListener('transitionend', measure);
    region.style.removeProperty(NOTICE_ROOM_VAR);
    region.removeAttribute(NOTICE_CROWDED_ATTR);
  };
}
