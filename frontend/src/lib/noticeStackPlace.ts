/**
 * Where the notice region's stack sits, and how tall the proposal card may be
 * (GM - Design, PR #216 r3: "the notice region is one stack, moves as one;
 * the card is the only part that shrinks"; r5: the give-way order).
 *
 * - The region clears the left tool rail and a docked Agent log (CSS:
 *   noticeRegion.css). While that leaves at least BESIDE_LOG_MIN_W, the stack
 *   sits beside the log. Below it, the whole stack goes above the log: the
 *   region stops clearing the log (`data-above-log`) and the stack is lifted
 *   over the log's top edge (`--notice-stack-lift`). The log never moves (its body may give, step 4).
 * - A log dragged off the dock that sits in the card's column is cleared too
 *   (GM r4 6): the card stays under it when there is room, else above it.
 * - The room is the stack's line up to the top line (the app's top bars, the
 *   offline banner among them; GM r4 7).
 *
 * Never covered (GM r5): the docked log's header and its collapse control;
 * the card's header, its plan line and its footer ("Accept never shows
 * without the line saying what runs and what it costs"). Notices never
 * overlap each other. The give-way order, as the room runs out:
 *
 * 0. `under`: the card on top, the notices under it, while the card's body
 *    keeps its note and plan line whole (`bodyFloors().full`).
 * 1. GM r5 1, notices over the body's foot while the plan line stays clear:
 *    that holds exactly the room of step 0 (the notices and their gaps come
 *    out of the same column either way), so with the plan line as the floor
 *    it is never the better place and the order goes on to step 2.
 * 2. `above`: the notices move above the card, over the canvas, under the
 *    top line, in the same column, the newest nearest the card. The card sits
 *    on the stack's line and its body keeps at least its plan line; the note
 *    scrolls behind its fade (`keepPlan`: the region scrolls the body so the
 *    plan line shows).
 * 3. `folded`: no room above for them all: the older notices fold into one
 *    row, "1 more notice" / "2 more notices", which unfolds on click; the
 *    newest stays whole with its Undo. Unfolded, the stack is step 2's.
 * 4. GM r6: only when even header, kept lines, footer and step 3's rows
 *    can't fit, the docked log's body gives way: it shrinks on the layout
 *    spring (`squeeze`, written as --agent-log-squeeze), down to its floor of
 *    header and 2 rows (AgentLog's --agent-log-floor), its header moving down
 *    with its top, whole and clear. It grows back when the card leaves.
 * 5. Only below that floor does the card's body go under its kept lines,
 *    down to one line, the plan line scrolling behind the fade
 *    (`underFade`). Past that the window is too short for header, one line
 *    and footer: the card's foot comes down over the log by the rest
 *    (`over`; the grid test lists those cells with their numbers).
 *
 * The kept lines (`KEEP_ATTR`): the plan line, and the first not-ready ⚠
 * row when there is one (GM r6). The body shows whole lines: the region
 * scrolls the last kept line to sit just over the bottom fade, so a line cut
 * by either edge is one under a fade.
 *
 * A move between steps glides on the layout spring (glideStack): no jump.
 */

/** Below this much room beside a docked Agent log, the stack sits above it. */
export const BESIDE_LOG_MIN_W = 400;
/** The card's scrolling body keeps about three note lines while it can. */
export const MIN_BODY_PX = 60;
/** The card's top never passes the app's top line plus this gutter. */
export const TOP_GUTTER = 16;
/** A floating Agent log's clearance, as the docked log's (AgentLog AGENT_LOG_GAP_PX). */
export const FLOAT_GAP_PX = 8;
/** The card body's fade on an edge that hides content (canvasProposals.css). */
export const FADE_PX = 16;
/** The folded notices' one row (noticeRegion.css .notice-region__more). */
export const MORE_ROW_PX = 32;
/** A step change's glide, the stack's spring's length. */
export const GLIDE_MS = 420;

/** Attributes the region reads: the item that shrinks, its body, its footer
 * and the line it keeps (the plan line). */
export const SHRINK_ATTR = 'data-notice-shrinks';
export const SHRINK_BODY_ATTR = 'data-notice-shrink-body';
export const SHRINK_FOOT_ATTR = 'data-notice-shrink-foot';
export const KEEP_ATTR = 'data-notice-keep';
/** The region's mark for the frame a layout switch lands in: no spring (GM r4). */
export const JUMP_ATTR = 'data-notice-jump';
/** An older notice folded into the "more notices" row (step 3). */
export const FOLD_ATTR = 'data-notice-folded';
/** The "N more notices" row, and the region's mark while it shows. */
export const MORE_ATTR = 'data-notice-more';
export const MORE_SHOWN_ATTR = 'data-notice-more-shown';
/** The unfolded row's words (as the note's Show all / Show less). */
export const SHOW_LESS = 'Show less';
/** On the root: how far the docked log's body gives way (layouts.css). */
export const LOG_SQUEEZE_VAR = '--agent-log-squeeze';

export type StackMode = 'under' | 'above' | 'folded';

export interface CardMeasure {
  /** The card's fixed rows (header, footer, borders) and its body's full height. */
  chrome: number;
  body: number;
  /** Its footer and bottom border. */
  foot?: number;
  /** One line of its body. */
  line?: number;
  /** The notices in the stack, top to bottom, and the stack's gap. */
  items?: number[];
  gap?: number;
  /** The kept lines (the plan line, and the first ⚠ row), in the body's
   * content: the first one's top and the last one's foot, unscrolled. */
  plan?: { top: number; bottom: number } | null;
}

export interface StackMeasure {
  viewportW: number;
  viewportH: number;
  /** The page gutter, the region's right inset with no log. */
  gutter: number;
  /** The region's left edge (the rail's clearance, or the gutter). */
  regionLeft: number;
  /** How far the region's bottom line sits above the window's bottom. */
  regionBottom: number;
  /** --agent-log-clearance and --agent-log-top; 0 when the log isn't docked. */
  logClearance: number;
  logTop: number;
  /** noticeTopLimit(TOP_GUTTER): the line the stack's top stays under. */
  topLine: number;
  /** How far a docked, open log's body may give way: its height less its
   * floor of header and 2 rows (0 for a closed or floating log). */
  logSpare?: number;
  /** The card, when one shows. */
  card: CardMeasure | null;
  /** An undocked Agent log's box (window coordinates), when one shows. */
  floating?: { top: number; bottom: number; left: number; right: number } | null;
  /** The card's column (window x), for the floating log's test. */
  column?: { left: number; right: number } | null;
}

export interface StackPlace {
  aboveLog: boolean;
  /** How far the stack is lifted off the region's bottom line. */
  lift: number;
  /** The card's max height, or null with no card. */
  cap: number | null;
  /** The give-way step, or null with no card. */
  mode: StackMode | null;
  /** How many older notices are folded into the "more" row. */
  folded: number;
  /** The "more" row's count, 0 while it is hidden. */
  more: number;
  /** The person unfolded the row: it shows, aria-expanded. */
  expanded: boolean;
  /** The body is shorter than note and plan line: scroll the plan line in. */
  keepPlan: boolean;
  /** Step 4: how far the docked log's body gives way. */
  squeeze: number;
  /** Step 5: the body is shorter than its kept lines (they scroll behind
   * the fade), and how far the card's foot then crosses the log's line. */
  underFade: boolean;
  over: number;
  /** The line the stack's top stays under (a floating log's foot may lower it). */
  topLine?: number;
}

const ONE_LINE_PX = 20;

/** The body heights the card keeps: `full` shows the note and the plan line
 * whole; `min` the plan line alone, the note scrolled behind the top fade
 * (GM r5 2). With no plan line, the old minimum and one line. */
export function bodyFloors(card: CardMeasure): { full: number; min: number } {
  const body = card.body;
  const line = Math.min(card.line ?? ONE_LINE_PX, body);
  const least = Math.min(MIN_BODY_PX, body);
  if (!card.plan) return { full: least, min: line };
  const full = Math.min(body, Math.max(least, card.plan.bottom + FADE_PX));
  const min = Math.min(full, card.plan.bottom - card.plan.top + 2 * FADE_PX);
  return { full, min };
}

/** The "N more notices" row's words. */
export function moreLabel(count: number): string {
  return count === 1 ? '1 more notice' : `${count} more notices`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function placeNoticeStack(m: StackMeasure, options: { expanded?: boolean } = {}): StackPlace {
  const docked = m.logClearance > 0 && m.logTop > 0;
  const beside = m.viewportW - Math.max(m.gutter, m.logClearance) - m.regionLeft;
  const aboveLog = docked && beside < BESIDE_LOG_MIN_W;
  let base = aboveLog ? Math.max(0, Math.ceil(m.logTop - m.regionBottom)) : 0;
  const none = { folded: 0, more: 0, expanded: false, keepPlan: false, squeeze: 0, underFade: false, over: 0 };
  if (!m.card) return { aboveLog, lift: base, cap: null, mode: null, ...none };
  const card = m.card;
  const gap = card.gap ?? 8;
  const items = card.items ?? [];
  const count = items.length;
  // Each notice and the gap over it.
  const below = sum(items) + gap * count;
  // Step 3's rows: the "more" row and the newest, each with its gap.
  const foldable = count >= 2;
  const foldedRows = foldable ? MORE_ROW_PX + gap + items[count - 1] + gap : below;
  const floors = bodyFloors(card);
  let topLine = m.topLine;

  // A floating log in the card's column (GM r4 6): under it when the stack
  // fits between its foot and the stack's line, else above it when it fits
  // there. When neither fits, under it: the stack's top then crosses the
  // log's body, never its header (the stack above it would come down over it).
  const float = docked ? null : m.floating;
  if (float && m.column && float.left < m.column.right && float.right > m.column.left
      && float.bottom > topLine && float.top < m.viewportH - m.regionBottom - base) {
    const line0 = m.viewportH - m.regionBottom - base;
    const needs = card.chrome + floors.min + foldedRows;
    const under = line0 - (float.bottom + FLOAT_GAP_PX);
    const over = float.top - FLOAT_GAP_PX - topLine;
    if (under >= needs || over < needs) {
      topLine = Math.max(topLine, Math.ceil(float.bottom + FLOAT_GAP_PX));
    } else {
      base = Math.max(base, Math.ceil(m.viewportH - float.top + FLOAT_GAP_PX - m.regionBottom));
    }
  }

  // The room from the stack's line up to the top line.
  const room = m.viewportH - m.regionBottom - base - topLine;
  // Only a docked log the stack sits above gives way.
  const logSpare = aboveLog ? Math.max(0, Math.floor(m.logSpare ?? 0)) : 0;
  const place = (mode: StackMode, rows: number, more = 0, expanded = false): StackPlace => {
    const cap = Math.floor(room - rows);
    const keep = card.chrome + floors.min;
    const least = card.chrome + Math.min(card.line ?? ONE_LINE_PX, card.body);
    // Step 4: the log's body gives way, down to its floor.
    const squeeze = Math.min(Math.max(0, Math.ceil(keep - cap)), logSpare);
    const room4 = cap + squeeze;
    // Step 5: the body under its kept lines, down to one line; then the foot.
    const over = Math.max(0, Math.ceil(least - room4));
    const lift = Math.max(0, base - squeeze - over);
    // The squeeze only ever brings the room up to the kept lines, so the
    // room is the body's height; the body never goes under one line.
    const height = Math.max(room4, least);
    return {
      aboveLog, lift, cap: height, mode, topLine, squeeze, over: Math.max(0, base - squeeze - lift),
      underFade: height - card.chrome < floors.min,
      folded: mode === 'folded' ? count - 1 : 0, more, expanded,
      keepPlan: height - card.chrome < floors.full,
    };
  };

  // Step 0: the notices under the card, note and plan line whole.
  if (count === 0) return place('under', 0);
  if (room - below - card.chrome >= floors.full) return place('under', below);
  // Step 2: above the card, its body down to the plan line.
  if (room - below - card.chrome >= floors.min || !foldable) return place('above', below);
  // Step 3: the older ones fold into one row; unfolded, step 2 with the row.
  if (options.expanded) return place('above', MORE_ROW_PX + gap + below, count - 1, true);
  return place('folded', foldedRows, count - 1);
}

/** Where everything lands (window y), for the placement's invariants: the
 * card's header, plan line and footer, and each row in the stack. */
export interface StackGeometry {
  card: { top: number; headBottom: number; plan: { top: number; bottom: number } | null; footTop: number; bottom: number } | null;
  rows: Array<{ top: number; bottom: number; kind: 'notice' | 'more' }>;
  /** The stack's line: the log's top edge (above a docked log) or the region's. */
  line: number;
}

export function stackGeometry(m: StackMeasure, place: StackPlace): StackGeometry {
  const line = m.viewportH - m.regionBottom - place.lift;
  const card = m.card;
  if (!card || place.cap === null || place.mode === null) return { card: null, rows: [], line };
  const gap = card.gap ?? 8;
  const items = card.items ?? [];
  const height = Math.min(place.cap, card.chrome + card.body);
  const foot = card.foot ?? 0;
  // The rows outside the card, top to bottom.
  const shown: Array<{ h: number; kind: 'notice' | 'more' }> = [];
  if (place.more) shown.push({ h: MORE_ROW_PX, kind: 'more' });
  items.forEach((h, index) => { if (index >= place.folded) shown.push({ h, kind: 'notice' }); });
  const rows: StackGeometry['rows'] = [];
  let cardBottom: number;
  if (place.mode === 'under') {
    cardBottom = line - sum(shown.map((row) => row.h + gap));
    let top = cardBottom;
    for (const row of shown) { top += gap; rows.push({ top, bottom: top + row.h, kind: row.kind }); top += row.h; }
  } else {
    cardBottom = line;
    let bottom = cardBottom - height;
    for (const row of [...shown].reverse()) { bottom -= gap; rows.unshift({ top: bottom - row.h, bottom, kind: row.kind }); bottom -= row.h; }
  }
  const top = cardBottom - height;
  const headBottom = top + card.chrome - foot;
  const visible = height - card.chrome;
  let plan: { top: number; bottom: number } | null = null;
  if (card.plan) {
    const tall = card.plan.bottom - card.plan.top;
    // Unscrolled while it fits with the fade under it; else scrolled in (keepPlan).
    const bottom = card.plan.bottom + (card.plan.bottom < card.body ? FADE_PX : 0) <= visible
      ? headBottom + card.plan.bottom
      : headBottom + visible - FADE_PX;
    plan = { top: bottom - tall, bottom };
  }
  return { card: { top, headBottom, plan, footTop: cardBottom - foot, bottom: cardBottom }, rows, line };
}

/** Whether a new place is a layout switch (GM r4; review 2 MEDIUM-1): the
 * stack went above the log or back, or the log it clears moved, so the lift
 * lands in that frame with no spring. A change inside the stack (a notice
 * coming or going) keeps the spring; a give-way step glides (glideStack). */
export function stackJumps(prev: { place: StackPlace; logTop: number; floatTop: number } | null,
  next: { place: StackPlace; logTop: number; floatTop: number }): boolean {
  if (!prev) return false;
  return prev.place.aboveLog !== next.place.aboveLog || prev.logTop !== next.logTop || prev.floatTop !== next.floatTop;
}

/** Whether the give-way step changed: the order, the fold or the row. */
export function stepChanged(prev: StackPlace | null, next: StackPlace): boolean {
  if (!prev) return false;
  return prev.mode !== next.mode || prev.folded !== next.folded || prev.more !== next.more;
}

function px(value: string): number {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

/** The notices in the stack, top to bottom (the card is not one). */
function noticeItems(stack: HTMLElement): HTMLElement[] {
  return [...stack.querySelectorAll<HTMLElement>('[data-notice-slot] > *')].filter((item) => !item.hasAttribute(SHRINK_ATTR));
}

function scrollerOf(card: HTMLElement): HTMLElement | null {
  const body = card.querySelector<HTMLElement>(`[${SHRINK_BODY_ATTR}]`);
  if (!body) return null;
  return body.firstElementChild instanceof HTMLElement ? body.firstElementChild : body;
}

/** Reads the live layout for placeNoticeStack. Read from the items' own
 * layout heights, never their places or their boxes on screen, so neither
 * the step in force nor a scale or glide in flight changes it. */
export function measureNoticeStack(region: HTMLElement, stack: HTMLElement, topLine: number): StackMeasure {
  const root = getComputedStyle(document.documentElement);
  const rect = region.getBoundingClientRect();
  const card = stack.querySelector<HTMLElement>(`[${SHRINK_ATTR}]`);
  const body = card?.querySelector<HTMLElement>(`[${SHRINK_BODY_ATTR}]`) ?? null;
  let shrink: StackMeasure['card'] = null;
  let column: StackMeasure['column'] = null;
  if (card && body) {
    const cardRect = card.getBoundingClientRect();
    // The card's own scale on screen (its entrance, a glide): boxes read
    // inside it are divided back to layout pixels.
    const scale = card.offsetHeight > 0 && cardRect.height > 0 ? cardRect.height / card.offsetHeight : 1;
    const scroller = scrollerOf(card) ?? body;
    const foot = card.querySelector<HTMLElement>(`[${SHRINK_FOOT_ATTR}]`);
    const kept = [...card.querySelectorAll<HTMLElement>(`[${KEEP_ATTR}]`)];
    let plan: CardMeasure['plan'] = null;
    if (kept.length) {
      const from = scroller.getBoundingClientRect().top;
      const boxes = kept.map((element) => element.getBoundingClientRect());
      plan = {
        top: Math.round((Math.min(...boxes.map((b) => b.top)) - from) / scale + scroller.scrollTop),
        bottom: Math.round((Math.max(...boxes.map((b) => b.bottom)) - from) / scale + scroller.scrollTop),
      };
    }
    shrink = {
      chrome: Math.max(0, card.offsetHeight - body.offsetHeight),
      body: scroller.scrollHeight,
      foot: foot ? Math.max(0, Math.round((cardRect.bottom - foot.getBoundingClientRect().top) / scale)) : 0,
      line: px(getComputedStyle(scroller).lineHeight) || ONE_LINE_PX,
      items: noticeItems(stack).map((item) => item.offsetHeight),
      gap: px(getComputedStyle(stack).rowGap) || 8,
      plan,
    };
    column = { left: cardRect.left, right: cardRect.right };
  }
  const floatTop = px(root.getPropertyValue('--agent-log-float-top'));
  const floatBottom = px(root.getPropertyValue('--agent-log-float-bottom'));
  return {
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    gutter: px(root.getPropertyValue('--page-gutter')) || 16,
    regionLeft: rect.left,
    // Read without the lift, which moves the stack and never the region.
    regionBottom: window.innerHeight - rect.bottom,
    logClearance: px(root.getPropertyValue('--agent-log-clearance')),
    logTop: px(root.getPropertyValue('--agent-log-top')),
    topLine,
    // AgentLog writes the docked log's height without any give, and its floor.
    logSpare: Math.max(0, px(root.getPropertyValue('--agent-log-natural-h')) - px(root.getPropertyValue('--agent-log-floor'))),
    card: shrink,
    floating: floatBottom > 0 ? {
      top: floatTop, bottom: floatBottom,
      left: px(root.getPropertyValue('--agent-log-float-left')), right: px(root.getPropertyValue('--agent-log-float-right')),
    } : null,
    column,
  };
}

type Box = { top: number; bottom: number; height: number };
const resting = new WeakMap<Element, Box>();
const gliding = new WeakMap<Element, Animation>();

function box(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, height: rect.height };
}

/** Its box in the layout, without the transform it draws with now (a glide's
 * translate, an entrance's scale about its centre). */
export function layoutBox(element: Element): Box {
  const seen = box(element);
  const matrix = /^matrix\(([^)]+)\)$/.exec(getComputedStyle(element).transform || '');
  if (!matrix) return seen;
  const [, , , d = 1, , f = 0] = matrix[1].split(',').map((part) => Number.parseFloat(part));
  const scale = d || 1;
  const height = seen.height / scale;
  const top = seen.top - f - (height * (1 - scale)) / 2;
  return { top, bottom: top + height, height };
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A give-way step's glide (GM r5: "Every transition between these steps
 * glides on the layout spring, with no jump. Reduced motion makes it
 * instant."): each row and the card start where they were last seen and
 * spring to their new place. The card is held by its footer, the rows by
 * their tops. Returns the moves it started.
 */
export function glideStack(elements: Array<{ element: HTMLElement; from: Box | undefined; foot?: boolean }>, easing: string): number {
  let moved = 0;
  for (const { element, from, foot } of elements) {
    if (!from || from.height === 0 || element.hasAttribute(FOLD_ATTR)) continue;
    const to = layoutBox(element);
    if (to.height === 0) continue;
    const dy = foot ? from.bottom - to.bottom : from.top - to.top;
    if (Math.abs(dy) < 1 || typeof element.animate !== 'function') continue;
    const move = element.animate(
      [{ transform: `translateY(${Math.round(dy)}px)` }, { transform: 'translateY(0)' }],
      { duration: GLIDE_MS, easing },
    );
    gliding.set(element, move);
    move.addEventListener?.('finish', () => { if (gliding.get(element) === move) gliding.delete(element); });
    moved += 1;
  }
  return moved;
}

/** Writes a place: the region's mode and lift, the card's cap, the order,
 * the fold and the "more" row, and the plan line scrolled into view. `jump`
 * lands it with no spring for this frame; `glide` (a step change) lands it
 * the same way and springs each row from where it was. */
export function applyNoticeStack(region: HTMLElement, stack: HTMLElement, place: StackPlace, jump = false, glide = false): void {
  const card = stack.querySelector<HTMLElement>(`[${SHRINK_ATTR}]`);
  const items = noticeItems(stack);
  const more = stack.querySelector<HTMLElement>(`[${MORE_ATTR}]`);
  const moving = [...(card ? [card] : []), ...items, ...(more ? [more] : [])];
  const animate = glide && !reducedMotion();
  // Where each was last seen: mid-glide its live box, else its last resting
  // one. A new step's glide takes over from one in flight; any other place
  // lets it run on.
  const from = new Map(moving.map((element) => [element, gliding.has(element) ? box(element) : resting.get(element)]));
  if (animate) moving.forEach((element) => { gliding.get(element)?.cancel(); gliding.delete(element); });
  if (jump || glide) {
    region.setAttribute(JUMP_ATTR, '');
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16);
    frame(() => frame(() => region.removeAttribute(JUMP_ATTR)));
  }
  if (place.aboveLog) region.dataset.aboveLog = 'true';
  else delete region.dataset.aboveLog;
  region.style.setProperty('--notice-stack-lift', `${place.lift}px`);
  if (card && place.cap !== null) card.style.setProperty('--notice-card-cap', `${place.cap}px`);
  if (place.mode) region.dataset.noticeMode = place.mode;
  else delete region.dataset.noticeMode;
  // A folded notice is inert too: no focus (the dialogs' focus order skips
  // it, lib/modalFocus.ts) and nothing a screen reader walks into.
  items.forEach((item, index) => {
    if (index < place.folded) {
      item.setAttribute(FOLD_ATTR, '');
      item.setAttribute('inert', '');
      resting.delete(item);
    } else if (item.hasAttribute(FOLD_ATTR)) {
      item.removeAttribute(FOLD_ATTR);
      item.removeAttribute('inert');
    }
  });
  if (place.more) region.setAttribute(MORE_SHOWN_ATTR, '');
  else region.removeAttribute(MORE_SHOWN_ATTR);
  if (more) {
    more.hidden = !place.more;
    more.textContent = !place.more ? '' : place.expanded ? SHOW_LESS : moreLabel(place.more);
    more.setAttribute('aria-expanded', String(place.expanded));
  }
  // The spring is off for this frame: read the layout so the jump lands now.
  void stack.offsetHeight;
  // GM r5 2: the body keeps its plan line; the note scrolls behind its fade.
  const scroller = card ? scrollerOf(card) : null;
  const kept = card ? [...card.querySelectorAll<HTMLElement>(`[${KEEP_ATTR}]`)] : [];
  if (place.keepPlan && scroller && kept.length) {
    // The last kept line's foot just over the bottom fade: whole, and any
    // line the edge cuts sits under a fade (GM r6).
    const foot = Math.max(...kept.map((element) => element.getBoundingClientRect().bottom));
    const short = foot - (scroller.getBoundingClientRect().bottom - FADE_PX);
    if (short > 0) scroller.scrollTop += Math.ceil(short);
  }
  // Step 4: the docked log's body gives way by the squeeze, or grows back.
  const root = document.documentElement;
  const squeeze = place.squeeze > 0 ? `${place.squeeze}px` : '';
  if (root.style.getPropertyValue(LOG_SQUEEZE_VAR) !== squeeze) {
    if (squeeze) root.style.setProperty(LOG_SQUEEZE_VAR, squeeze);
    else root.style.removeProperty(LOG_SQUEEZE_VAR);
  }
  // Where each now rests in the layout, whatever it draws with.
  moving.forEach((element) => { if (!element.hasAttribute(FOLD_ATTR)) resting.set(element, layoutBox(element)); });
  if (animate) {
    const easing = getComputedStyle(region).getPropertyValue('--notice-spring').trim() || 'ease-out';
    glideStack(moving.map((element) => ({ element, from: from.get(element), foot: element === card })), easing);
  }
}
