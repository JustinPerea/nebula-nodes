/**
 * Where the notice region's stack sits, and how tall the proposal card may be
 * (GM - Design, PR #216 r3: "the notice region is one stack, moves as one;
 * the card is the only part that shrinks"; r4: the give-way order).
 *
 * - The region clears the left tool rail and a docked Agent log (CSS:
 *   noticeRegion.css). While that leaves at least BESIDE_LOG_MIN_W, the stack
 *   sits beside the log. Below it, the whole stack goes above the log: the
 *   region stops clearing the log (`data-above-log`) and the stack is lifted
 *   over the log's top edge (`--notice-stack-lift`). The log never moves.
 * - A log dragged off the dock that sits in the card's column is cleared too
 *   (GM r4 6): the card stays under it when there is room, else above it.
 * - The card's height cap is the room from the stack's bottom line up to the
 *   top line (the app's top bars, the offline banner among them; GM r4 7),
 *   less the notices under the card and their gaps.
 * - When that leaves the body less than MIN_BODY_PX, the stack gives way in
 *   GM r4 5's order, and the docked log's header is never covered before the
 *   last step; the card's header and footer always show in full:
 *   1. the notices with no room under the card go over the bottom of the
 *      card's body, just above its footer (`overlay`): the card sits on the
 *      log's line and its body keeps the notices' room at its foot;
 *   2. the body shrinks below MIN_BODY_PX, down to one line;
 *   3. only when header, one line and footer still can't fit does the card's
 *      foot come down over the log's header.
 */

/** Below this much room beside a docked Agent log, the stack sits above it. */
export const BESIDE_LOG_MIN_W = 400;
/** The card's scrolling body keeps about three note lines while it can. */
export const MIN_BODY_PX = 60;
/** The card's top never passes the app's top line plus this gutter. */
export const TOP_GUTTER = 16;
/** A floating Agent log's clearance, as the docked log's (AgentLog AGENT_LOG_GAP_PX). */
export const FLOAT_GAP_PX = 8;

/** Attributes the region reads: the item that shrinks, its body and its footer. */
export const SHRINK_ATTR = 'data-notice-shrinks';
export const SHRINK_BODY_ATTR = 'data-notice-shrink-body';
export const SHRINK_FOOT_ATTR = 'data-notice-shrink-foot';
/** The region's mark for the frame a layout switch lands in: no spring (GM r4). */
export const JUMP_ATTR = 'data-notice-jump';

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
  /** floatingTopLimit(TOP_GUTTER): the line the card's top stays under. */
  topLine: number;
  /** The card, when one shows: what lies under it in the stack (notices and
   * gaps), its fixed rows (header, footer, borders) and its body's full height.
   * `foot`: its footer and bottom border; `line`: one line of its body;
   * `items`: the notices under it, top to bottom; `gap`: the stack's gap. */
  card: { below: number; chrome: number; body: number; foot?: number; line?: number; items?: number[]; gap?: number } | null;
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
  /** Give-way step 1: how far each notice under the card moves up (negative
   * px, top to bottom) to sit over the body's foot, and the room the body
   * keeps there for them. Null while they sit under the card. */
  overlay?: { offsets: number[]; pad: number; floor: number } | null;
  /** The line the card's top stays under (a floating log's foot may lower it). */
  topLine?: number;
}

const ONE_LINE_PX = 20;

export function placeNoticeStack(m: StackMeasure): StackPlace {
  const docked = m.logClearance > 0 && m.logTop > 0;
  const beside = m.viewportW - Math.max(m.gutter, m.logClearance) - m.regionLeft;
  const aboveLog = docked && beside < BESIDE_LOG_MIN_W;
  let base = aboveLog ? Math.max(0, Math.ceil(m.logTop - m.regionBottom)) : 0;
  if (!m.card) return { aboveLog, lift: base, cap: null, overlay: null };
  const card = m.card;
  const gap = card.gap ?? 8;
  const line = Math.min(card.line ?? ONE_LINE_PX, card.body);
  let topLine = m.topLine;
  const least = card.chrome + Math.min(MIN_BODY_PX, card.body);

  // A floating log in the card's column (GM r4 6): under it when the stack
  // fits between its foot and the stack's line, else above it.
  const float = docked ? null : m.floating;
  if (float && m.column && float.left < m.column.right && float.right > m.column.left
      && float.bottom > topLine && float.top < m.viewportH - m.regionBottom - base) {
    const line0 = m.viewportH - m.regionBottom - base;
    const under = line0 - (float.bottom + FLOAT_GAP_PX);
    const over = float.top - FLOAT_GAP_PX - topLine;
    if (under >= least + card.below || under >= over) topLine = Math.max(topLine, Math.ceil(float.bottom + FLOAT_GAP_PX));
    else base = Math.max(base, Math.ceil(m.viewportH - float.top + FLOAT_GAP_PX - m.regionBottom));
  }

  // The room from the stack's line up to the top line.
  const room = m.viewportH - m.regionBottom - base - topLine;
  if (card.below === 0 || room - card.below >= least) {
    if (card.below > 0) return { aboveLog, lift: base, cap: Math.floor(room - card.below), overlay: null, topLine };
    // No notices: step 2, then step 3.
    const floor = card.chrome + line;
    if (room >= floor) return { aboveLog, lift: base, cap: Math.floor(room), overlay: null, topLine };
    return { aboveLog, lift: Math.max(0, Math.ceil(base - (floor - room))), cap: floor, overlay: null, topLine };
  }

  // Step 1: the notices go over the body's foot, the card on the stack's line.
  const items = card.items && card.items.length ? card.items : [Math.max(0, card.below - gap)];
  const pile = items.reduce((sum, h) => sum + h, 0) + gap * (items.length - 1);
  const tallest = Math.max(...items);
  // Step 2: the body (the notices' room at its foot included) shrinks down
  // to one line, never less than the newest notice and its gap; the notice
  // nearest the footer shows whole (it keeps the button, lib/noticeSlots.ts)
  // and, when even that is too little, older ones tuck under it.
  const floorBody = Math.max(line, gap + tallest);
  const floor = card.chrome + floorBody;
  const cap = Math.max(floor, Math.floor(room));
  // Step 3: header, that body and footer can't fit: the card's foot comes down.
  const cardLift = room >= floor ? base : Math.max(0, Math.ceil(base - (floor - room)));
  const height = Math.min(cap, card.chrome + card.body + gap + pile);
  const pad = Math.max(gap + tallest, Math.min(gap + pile, height - card.chrome));
  // Each notice's move up: from its place under the card to the body's foot.
  const foot = card.foot ?? 0;
  const span = pad - gap;
  const step = items.length > 1 ? (span - items.reduce((sum, h) => sum + h, 0)) / (items.length - 1) : 0;
  const offsets: number[] = [];
  let layoutTop = gap;
  let visualBottom = -(foot + gap);
  const visualTops: number[] = [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    visualTops[i] = visualBottom - items[i];
    visualBottom = visualTops[i] - step;
  }
  for (let i = 0; i < items.length; i += 1) {
    offsets.push(Math.round(visualTops[i] - layoutTop));
    layoutTop += items[i] + gap;
  }
  return {
    aboveLog, lift: cardLift - card.below, cap, topLine,
    overlay: { offsets, pad: Math.ceil(pad), floor: Math.ceil(Math.max(pad, floorBody)) },
  };
}

/** Whether a new place is a layout switch (GM r4; review 2 MEDIUM-1): the
 * stack went above the log or back, or the log it clears moved, so the lift
 * lands in that frame with no spring. A change inside the stack (a notice
 * coming or going) keeps the spring. */
export function stackJumps(prev: { place: StackPlace; logTop: number; floatTop: number } | null,
  next: { place: StackPlace; logTop: number; floatTop: number }): boolean {
  if (!prev) return false;
  return prev.place.aboveLog !== next.place.aboveLog || prev.logTop !== next.logTop || prev.floatTop !== next.floatTop;
}

function px(value: string): number {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

/** The notices under the card, top to bottom. */
function noticeItems(stack: HTMLElement): HTMLElement[] {
  return [...stack.querySelectorAll<HTMLElement>('[data-notice-slot] > *')].filter((item) => !item.hasAttribute(SHRINK_ATTR));
}

/** Reads the live layout for placeNoticeStack. */
export function measureNoticeStack(region: HTMLElement, stack: HTMLElement, topLine: number): StackMeasure {
  const root = getComputedStyle(document.documentElement);
  const rect = region.getBoundingClientRect();
  const card = stack.querySelector<HTMLElement>(`[${SHRINK_ATTR}]`);
  const body = card?.querySelector<HTMLElement>(`[${SHRINK_BODY_ATTR}]`) ?? null;
  let shrink: StackMeasure['card'] = null;
  let column: StackMeasure['column'] = null;
  if (card && body) {
    const cardRect = card.getBoundingClientRect();
    const scroller = body.firstElementChild instanceof HTMLElement ? body.firstElementChild : body;
    const foot = card.querySelector<HTMLElement>(`[${SHRINK_FOOT_ATTR}]`);
    const items = noticeItems(stack);
    shrink = {
      // The card is the stack's top row: what is under it is the rest of the stack.
      below: Math.max(0, stack.getBoundingClientRect().bottom - cardRect.bottom),
      chrome: Math.max(0, cardRect.height - body.getBoundingClientRect().height),
      body: scroller.scrollHeight,
      foot: foot ? Math.max(0, cardRect.bottom - foot.getBoundingClientRect().top) : 0,
      line: px(getComputedStyle(scroller).lineHeight) || ONE_LINE_PX,
      items: items.map((item) => item.getBoundingClientRect().height),
      gap: px(getComputedStyle(stack).rowGap) || 8,
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
    card: shrink,
    floating: floatBottom > 0 ? {
      top: floatTop, bottom: floatBottom,
      left: px(root.getPropertyValue('--agent-log-float-left')), right: px(root.getPropertyValue('--agent-log-float-right')),
    } : null,
    column,
  };
}

/** Writes a place: the region's mode and lift, the card's cap and, while the
 * notices sit over its body's foot, the body's room for them and each
 * notice's move. `jump` lands it with no spring for this frame. */
export function applyNoticeStack(region: HTMLElement, stack: HTMLElement, place: StackPlace, jump = false): void {
  if (jump) {
    region.setAttribute(JUMP_ATTR, '');
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16);
    frame(() => frame(() => region.removeAttribute(JUMP_ATTR)));
  }
  if (place.aboveLog) region.dataset.aboveLog = 'true';
  else delete region.dataset.aboveLog;
  region.style.setProperty('--notice-stack-lift', `${place.lift}px`);
  const card = stack.querySelector<HTMLElement>(`[${SHRINK_ATTR}]`);
  if (card && place.cap !== null) card.style.setProperty('--notice-card-cap', `${place.cap}px`);
  const overlay = place.overlay ?? null;
  if (overlay) region.dataset.noticeOverlay = 'true';
  else delete region.dataset.noticeOverlay;
  if (card) {
    if (overlay) {
      card.style.setProperty('--notice-overlay-pad', `${overlay.pad}px`);
      card.style.setProperty('--notice-body-floor', `${overlay.floor}px`);
    } else {
      card.style.removeProperty('--notice-overlay-pad');
      card.style.removeProperty('--notice-body-floor');
    }
  }
  noticeItems(stack).forEach((item, index) => {
    const offset = overlay?.offsets[index];
    if (offset !== undefined) item.style.setProperty('--notice-overlay-y', `${offset}px`);
    else item.style.removeProperty('--notice-overlay-y');
  });
  // The spring is off for this frame: read the layout so the jump lands now.
  if (jump) void stack.offsetHeight;
}
