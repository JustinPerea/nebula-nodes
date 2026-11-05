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
 * off to the side never meets). `clearance` keeps the panel that much further
 * above the band's (or, with no band, the bar's) line: the unpinned Inspector
 * beside a node keeps FLOATING_CHROME_CLEARANCE (GM r72: "Cap to the BAND
 * line, not the bar: the reserved notice band wins").
 */
export function floatingBottomLimit(gutter: number, viewportHeight = window.innerHeight, span?: HorizontalSpan,
  clearance = 0): number {
  const edge = viewportHeight - gutter;
  const bar = bottomBarTop(span);
  const band = noticeBand();
  if (bar === null) return band ? Math.min(edge, band.top - clearance) : edge;
  return Math.min(edge, bar - BOTTOM_BAR_GAP - (band?.height ?? 0) - clearance);
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

export function floatingTopLimit(gutter: number, gap = BOTTOM_BAR_GAP): number {
  if (typeof document === 'undefined') return gutter;
  let line = gutter;
  for (const part of document.querySelectorAll<HTMLElement>(`[${TOP_BAR_ATTR}]`)) {
    const box = part.getBoundingClientRect();
    if (box.height <= 0) continue;
    line = Math.max(line, box.bottom + gap);
  }
  return line;
}

/**
 * Where the selection toolbar goes (GM r35 on PR #199): it must not cover
 * the selection. In order:
 * 1. its own place below the top stack (the workspace header, the World
 *    Labs notice and its reopen line), when that doesn't cover the
 *    selection: the selection is below it with the gap, or beside or above it;
 * 2. otherwise flipped below the selection, the usual floating-toolbar rule,
 *    when it fits above the bottom bar (and below the offline banner, which
 *    sits under the toolbar's own place);
 * 3. otherwise pinned in its own place, the only case that covers the
 *    selection. The camera never moves.
 * `home` is the toolbar's own top (its Panel, the marker floating panels
 * stop below, which never moves with it); boxes are viewport px.
 */
export interface ScreenBox { top: number; bottom: number; left: number; right: number }
export type SelectionToolbarPlace = 'clear' | 'between' | 'below' | 'pinned';

export function placeSelectionToolbar({ home, height, left, right, selection, stackBottom = null, bottomLimit, gap = BOTTOM_BAR_GAP }: {
  home: number; height: number; left: number; right: number;
  selection: ScreenBox | null;
  /** The lowest of the top stack's parts, the offline banner included, or null. */
  stackBottom?: number | null;
  bottomLimit: number;
  gap?: number;
}): { top: number; place: SelectionToolbarPlace } {
  if (!selection || selection.bottom <= selection.top) return { top: home, place: 'clear' };
  const acrossIt = left < selection.right && right > selection.left;
  const covers = (top: number) => acrossIt && top < selection.bottom + gap && top + height + gap > selection.top;
  if (!covers(home)) return { top: home, place: acrossIt && selection.top >= home + height + gap ? 'between' : 'clear' };
  const below = Math.max(selection.bottom + gap, home, stackBottom === null ? home : stackBottom + gap);
  if (below + height <= bottomLimit) return { top: below, place: 'below' };
  return { top: home, place: 'pinned' };
}

/** The top stack's parts that sit at the canvas's top over the toolbar's
 * line or under it (the World Labs notice box, the offline banner). */
export const TOP_STACK_ATTR = 'data-top-stack';
/** Said on the window when the stack changes, so the toolbar places itself again. */
export const TOP_STACK_EVENT = 'nebula:top-stack';

/** The bottom of the lowest part of the top stack on screen, or null. */
export function topStackBottom(): number | null {
  if (typeof document === 'undefined') return null;
  let bottom: number | null = null;
  for (const part of document.querySelectorAll<HTMLElement>(`[${TOP_STACK_ATTR}]`)) {
    const box = part.getBoundingClientRect();
    if (box.height <= 0) continue;
    bottom = bottom === null ? box.bottom : Math.max(bottom, box.bottom);
  }
  return bottom;
}

/** The selected nodes' box on screen (their union), or null. */
export function selectionScreenBox(within: ParentNode = document): ScreenBox | null {
  let box: ScreenBox | null = null;
  for (const node of within.querySelectorAll<HTMLElement>('.react-flow__node.selected')) {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    box = box === null
      ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
      : { top: Math.min(box.top, rect.top), bottom: Math.max(box.bottom, rect.bottom),
          left: Math.min(box.left, rect.left), right: Math.max(box.right, rect.right) };
  }
  return box;
}

export const SELECTION_TOOLBAR_OFFSET_VAR = '--selection-toolbar-offset';
export const SELECTION_TOOLBAR_PLACE_ATTR = 'data-toolbar-place';

/** Places `toolbar` (inside its Panel) by placeSelectionToolbar and writes
 * the result on the Panel: the offset from its own place, and the case. */
export function applySelectionToolbarPlace(toolbar: HTMLElement): SelectionToolbarPlace | null {
  const panel = toolbar.parentElement;
  if (!panel) return null;
  const home = panel.getBoundingClientRect().top;
  const bar = toolbar.getBoundingClientRect();
  const span = { left: bar.left, right: bar.right };
  const { top, place } = placeSelectionToolbar({
    home, height: toolbar.offsetHeight || bar.height, ...span,
    selection: selectionScreenBox(panel.closest('.react-flow') ?? document),
    stackBottom: topStackBottom(),
    bottomLimit: floatingBottomLimit(BOTTOM_BAR_GAP, window.innerHeight, span),
  });
  panel.style.setProperty(SELECTION_TOOLBAR_OFFSET_VAR, `${Math.round(top - home)}px`);
  panel.setAttribute(SELECTION_TOOLBAR_PLACE_ATTR, place);
  return place;
}

/**
 * The canvas's top notices (the World Labs notice, its held-reopen line
 * inside it) sit over the selection toolbar's line; the toolbar moves below
 * them while they show (review 20 lens item 4, GM r34 A5 on PR #199): the
 * notice covered 28% of the toolbar alone, and with the held-reopen line all
 * seven of its controls. The notice publishes its foot as
 * `--top-notice-bottom` (viewport px) and, for the toolbar's panel inside
 * the canvas, `--top-notice-clearance`: the toolbar's top under the notice
 * plus the 8 px gap, from the canvas's top edge. canvas.css takes the lower
 * of that and the toolbar's own 92 px; the offline banner, which sits under
 * the toolbar's line, reads the foot (App.css). Floating panels follow on
 * their own, since they stop below the toolbar's marker (floatingTopLimit).
 * With no notice, both are cleared and every line is where it was.
 */
export const TOP_NOTICE_BOTTOM_VAR = '--top-notice-bottom';
export const TOP_NOTICE_CLEARANCE_VAR = '--top-notice-clearance';

/** Writes the notice's foot on the root, or clears both values for null. */
export function publishTopNotice(notice: HTMLElement | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const box = notice?.getBoundingClientRect();
  if (!box || box.height <= 0) {
    root.style.removeProperty(TOP_NOTICE_BOTTOM_VAR);
    root.style.removeProperty(TOP_NOTICE_CLEARANCE_VAR);
    return;
  }
  const canvasTop = document.querySelector<HTMLElement>('.react-flow')?.getBoundingClientRect().top ?? 0;
  root.style.setProperty(TOP_NOTICE_BOTTOM_VAR, `${Math.ceil(box.bottom)}px`);
  root.style.setProperty(TOP_NOTICE_CLEARANCE_VAR, `${Math.max(0, Math.ceil(box.bottom + BOTTOM_BAR_GAP - canvasTop))}px`);
}

/** Tells the toolbar the top stack changed (a notice, its line or the banner came, went or grew). */
export function sayTopStackChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(TOP_STACK_EVENT));
}

/** Keeps `notice`'s foot published while it is on screen (its size and the
 * window's), and clears it when it goes. Returns the stop. */
export function watchTopNotice(notice: HTMLElement): () => void {
  const publish = () => { publishTopNotice(notice); sayTopStackChanged(); };
  publish();
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
  observer?.observe(notice);
  window.addEventListener('resize', publish);
  return () => {
    observer?.disconnect();
    window.removeEventListener('resize', publish);
    publishTopNotice(null);
    sayTopStackChanged();
  };
}

/**
 * How far floating chrome keeps clear of the top chrome and the bottom bar
 * (GM - Design r68 for the Inspector popover, r70 for the Agent log's
 * ceiling: "Same clearance as the r68 popover rule").
 */
export const CHROME_CLEARANCE = 12;

/**
 * On the selection toolbar's slot (its React Flow Panel, which also carries
 * `data-top-bar`). The slot keeps the toolbar's height while nothing is
 * selected (canvas.css), and reserves its width as
 * `--selection-toolbar-slot-w`: the widest the toolbar draws (896 px at
 * 1440 with a model node's actions), so the slot's span doesn't depend on
 * whether the toolbar shows, or on what is selected.
 */
export const TOOLBAR_SLOT_ATTR = 'data-toolbar-slot';
export const TOOLBAR_SLOT_WIDTH_VAR = '--selection-toolbar-slot-w';

/** The span across the window the toolbar's slot reserves, centred on the slot. */
export function toolbarSlotSpan(slot: HTMLElement, box: DOMRect = slot.getBoundingClientRect()): HorizontalSpan {
  const reserved = Number.parseFloat(getComputedStyle(slot).getPropertyValue(TOOLBAR_SLOT_WIDTH_VAR)) || 0;
  const width = Math.min(Math.max(box.width, reserved), window.innerWidth);
  const centre = box.left + box.width / 2;
  return { left: centre - width / 2, right: centre + width / 2 };
}

/**
 * The top line a floating box that reaches up stops at, `gap` below the top
 * chrome (GM - Design r70: "the selection toolbar's slot bottom + 12 px
 * whenever the log's horizontal span overlaps that slot (whether or not the
 * toolbar is showing — selecting a node must not move the log). Otherwise
 * the top bar + 12 px."). Over the slot (or with no `span`) it is
 * floatingTopLimit's line, the one source for "the toolbar + 12" shared
 * with the r68 popover rule; clear of the slot, the other top bars' line.
 * `floor` is the line with no top bar on screen.
 */
export function chromeTopLimit(span?: HorizontalSpan, gap = CHROME_CLEARANCE, floor = 0): number {
  if (typeof document === 'undefined') return floor;
  const slots = [...document.querySelectorAll<HTMLElement>(`[${TOP_BAR_ATTR}][${TOOLBAR_SLOT_ATTR}]`)];
  const overSlot = !span || slots.some((part) => {
    const box = part.getBoundingClientRect();
    if (box.height <= 0) return false;
    const slot = toolbarSlotSpan(part, box);
    return slot.right > span.left && slot.left < span.right;
  });
  if (overSlot) return floatingTopLimit(floor, gap);
  let line = floor;
  for (const part of document.querySelectorAll<HTMLElement>(`[${TOP_BAR_ATTR}]:not([${TOOLBAR_SLOT_ATTR}])`)) {
    const box = part.getBoundingClientRect();
    if (box.height <= 0) continue;
    line = Math.max(line, box.bottom + gap);
  }
  return line;
}

/** Parts of the top line only the notice stack's proposal card stays under,
 * besides the top bars: the offline banner (GM - Design, PR #216 r4 7). The
 * floating panels don't move for it. */
export const NOTICE_TOP_LINE_ATTR = 'data-notice-top-line';
/** On the root while the offline banner shows: the notice region places its
 * stack again when it comes or goes (NoticeRegion's root watch). */
export const BANNER_SHOWN_ATTR = 'data-offline-banner';

/** floatingTopLimit, and below the offline banner while it shows. */
export function noticeTopLimit(gutter: number): number {
  let line = floatingTopLimit(gutter);
  if (typeof document === 'undefined') return line;
  for (const part of document.querySelectorAll<HTMLElement>(`[${NOTICE_TOP_LINE_ATTR}]`)) {
    const box = part.getBoundingClientRect();
    if (box.height <= 0) continue;
    line = Math.max(line, box.bottom + gutter);
  }
  return line;
}

/**
 * How far the unpinned Inspector beside a node keeps clear of the floating
 * top chrome and of the notice band's line (GM r68: "with 12 px clear of
 * each"; r72: the band's line, not the bar's).
 */
export const FLOATING_CHROME_CLEARANCE = 12;

/**
 * The top line a panel that grows toward the floating top chrome stops at:
 * the selection toolbar's line (or the header's, whichever is lower; see
 * floatingTopLimit), FLOATING_CHROME_CLEARANCE below it. The only source for
 * that line: the unpinned Inspector's content fit uses it, and so does any
 * resize that reaches up to the chrome.
 */
export function floatingChromeTopLine(gutter: number): number {
  return floatingTopLimit(gutter, FLOATING_CHROME_CLEARANCE);
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
