/**
 * Where the notice region's stack sits, and how tall the proposal card may be
 * (GM - Design, PR #216 r3: "the notice region is one stack, moves as one;
 * the card is the only part that shrinks").
 *
 * - The region clears the left tool rail and a docked Agent log (CSS:
 *   noticeRegion.css). While that leaves at least BESIDE_LOG_MIN_W, the stack
 *   sits beside the log. Below it, the whole stack goes above the log: the
 *   region stops clearing the log (`data-above-log`) and the stack is lifted
 *   over the log's top edge (`--notice-stack-lift`). The log never moves.
 * - The card's height cap is the room from the stack's bottom line up to the
 *   top inset, less the notices under the card and their gaps.
 * - The card's body keeps MIN_BODY_PX. When the room above the log can't hold
 *   the card's header, that minimum and its footer, the lift gives way: the
 *   card keeps its minimum and its foot comes down over the log's top edge,
 *   so its top never passes the inset.
 */

/** Below this much room beside a docked Agent log, the stack sits above it. */
export const BESIDE_LOG_MIN_W = 400;
/** The card's scrolling body never gets less than about three note lines. */
export const MIN_BODY_PX = 60;
/** The card's top never passes the app's top line plus this gutter. */
export const TOP_GUTTER = 16;

/** Attributes the region reads: the item that shrinks, and its body. */
export const SHRINK_ATTR = 'data-notice-shrinks';
export const SHRINK_BODY_ATTR = 'data-notice-shrink-body';

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
   * gaps), its fixed rows (header, footer, borders) and its body's full height. */
  card: { below: number; chrome: number; body: number } | null;
}

export interface StackPlace {
  aboveLog: boolean;
  /** How far the stack is lifted off the region's bottom line. */
  lift: number;
  /** The card's max height, or null with no card. */
  cap: number | null;
}

export function placeNoticeStack(m: StackMeasure): StackPlace {
  const docked = m.logClearance > 0 && m.logTop > 0;
  const beside = m.viewportW - Math.max(m.gutter, m.logClearance) - m.regionLeft;
  const aboveLog = docked && beside < BESIDE_LOG_MIN_W;
  let lift = aboveLog ? Math.max(0, Math.ceil(m.logTop - m.regionBottom)) : 0;
  if (!m.card) return { aboveLog, lift, cap: null };
  const room = (at: number) => m.viewportH - m.regionBottom - at - m.card!.below - m.topLine;
  const least = m.card.chrome + Math.min(MIN_BODY_PX, m.card.body);
  if (room(lift) < least) lift = Math.max(0, Math.ceil(lift - (least - room(lift))));
  return { aboveLog, lift, cap: Math.max(0, Math.floor(room(lift))) };
}

function px(value: string): number {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

/** Reads the live layout for placeNoticeStack. */
export function measureNoticeStack(region: HTMLElement, stack: HTMLElement, topLine: number): StackMeasure {
  const root = getComputedStyle(document.documentElement);
  const rect = region.getBoundingClientRect();
  const card = stack.querySelector<HTMLElement>(`[${SHRINK_ATTR}]`);
  const body = card?.querySelector<HTMLElement>(`[${SHRINK_BODY_ATTR}]`) ?? null;
  let shrink: StackMeasure['card'] = null;
  if (card && body) {
    const cardRect = card.getBoundingClientRect();
    const scroller = body.firstElementChild instanceof HTMLElement ? body.firstElementChild : body;
    shrink = {
      // The card is the stack's top row: what is under it is the rest of the stack.
      below: Math.max(0, stack.getBoundingClientRect().bottom - cardRect.bottom),
      chrome: Math.max(0, cardRect.height - body.getBoundingClientRect().height),
      body: scroller.scrollHeight,
    };
  }
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
  };
}

/** Writes a place: the region's mode and lift, and the card's cap. */
export function applyNoticeStack(region: HTMLElement, stack: HTMLElement, place: StackPlace): void {
  if (place.aboveLog) region.dataset.aboveLog = 'true';
  else delete region.dataset.aboveLog;
  region.style.setProperty('--notice-stack-lift', `${place.lift}px`);
  const card = stack.querySelector<HTMLElement>(`[${SHRINK_ATTR}]`);
  if (card && place.cap !== null) card.style.setProperty('--notice-card-cap', `${place.cap}px`);
}
