import { setNoticeMore } from './noticeMore';

/**
 * Where the notice region's stack sits, and how tall the proposal card may be
 * (GM - Design, PR #216 r3: "the notice region is one stack, moves as one;
 * the card is the only part that shrinks"; r5: the give-way order).
 *
 * - The region clears the left tool rail and a docked Agent log (CSS:
 *   noticeRegion.css). While that leaves at least BESIDE_LOG_MIN_W, the stack
 *   sits beside the log. Below it, the whole stack goes above the log: the
 *   region stops clearing the log (`data-above-log`) and the stack is lifted
 *   over the log's top edge (`--notice-stack-lift`). The log never moves (it may give way, steps 3-4).
 * - A log dragged off the dock that sits in the card's column is cleared too
 *   (GM r4 6): the card stays under it when there is room, else above it.
 * - The room is the stack's line up to the top line (the app's top bars, the
 *   offline banner among them; GM r4 7).
 *
 * Never covered (GM r5): the docked log's header and its collapse control;
 * the card's header, its plan line and its footer ("Accept never shows
 * without the line saying what runs and what it costs"). Notices never
 * overlap each other. The give-way order, as the room runs out (GM r7: the
 * plan line goes last, after every notice and the log):
 *
 * 0. `under`: the card on top, the notices under it, while the card's body
 *    keeps its note and plan line whole (`bodyFloors().full`). (GM r5's
 *    "notices over the body's foot" holds exactly this room, so it is never
 *    the better place and isn't built.)
 * 1. `above`: the notices move above the card, over the canvas, under the
 *    top line, the newest nearest the card; the card's body keeps at least
 *    its kept lines, the note behind its fade (`keepPlan`).
 *    `folded`: no room above for them all: the older notices fold into one
 *    row, "1 more notice" / "2 more notices", which unfolds on click
 *    ("Show less"); the newest stays whole.
 * 2. `pill` (GM r7): every notice without an Undo folds into the one row,
 *    "1 notice" / "4 notices". A notice with an Undo (or Redo) never folds,
 *    here or in step 1.
 * 3. GM r6: the log's body gives way, on the layout spring (`squeeze`,
 *    written as --agent-log-squeeze), down to its floor of header and 2 rows
 *    (AgentLog's --agent-log-floor), held at its bottom edge so its header
 *    comes down whole. It grows back when the card leaves.
 * 4. GM r7: the log collapses to its header (`collapse`; the region asks
 *    uiStore, which reopens it when the card leaves, but never undoes a
 *    collapse the person made, and never collapses it again over the
 *    person's own reopening while the card shows).
 * 5. Only then does the card's body go under its kept lines (`underFade`),
 *    down to one line: the plan line stays whole first, the ⚠ line next in
 *    the scroll. Past that the window is too short for header, one line and
 *    footer: the card's foot comes down over the log by the rest (`over`;
 *    the grid test lists those cells with their numbers).
 *
 * A floating log in the card's column (GM r9), the log never moving:
 * 1. Beside it, when there is at least BESIDE_LOG_MIN_W of room on one side
 *    of it (r1's rule, `besideRoom`, the docked log's own test): the region
 *    stops short of the log on that side (`inset`), the more room first.
 * 2. Else the side of it, under or above, that holds the card: under it
 *    first (the log gives nothing there), else above it with its give
 *    (steps 3-4, its bottom edge held); with neither, the side with more
 *    room. The collapse orders here, after 1, because beside needs nothing
 *    from the log and it only ever frees room above the log.
 * 3. Else a named shortfall: step 5 on that side (the grid lists them).
 * A change of side, or of the inset, glides (`stepChanged`).
 *
 * Steps 3 and 4 are the docked log's when the stack sits above it, and a
 * floating log's in the card's column when the stack sits above it (GM r7:
 * "it gives way the same way", anchored at its bottom edge; where the person
 * put it never changes).
 *
 * The kept lines (`KEEP_ATTR`): the plan line, and the first not-ready ⚠
 * row when there is one (GM r6). The body shows whole lines: the region
 * scrolls the last kept line to sit just over the bottom fade, so a line cut
 * by either edge is one under a fade; under its kept lines, the plan line
 * sits just under the top fade.
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
/** On the root: how far the log's body gives way (layouts.css). */
export const LOG_SQUEEZE_VAR = '--agent-log-squeeze';
/** A notice that offers Undo or Redo marks itself so (else its button's
 * words are read): it never folds (GM r7). */
export const UNDO_ATTR = 'data-notice-undo';
/** A notice that can carry the fold's count in its own row marks where
 * (NoticeMoreInline); the one carrying it is marked `MORE_HOST_ATTR`. */
export const MORE_SLOT_ATTR = 'data-notice-more-slot';
export const MORE_HOST_ATTR = 'data-notice-more-host';
/** On the root, from AgentLog: what the log's collapse to its header frees
 * beyond its floor, while it may collapse (GM r7). */
export const LOG_COLLAPSE_VAR = '--agent-log-collapse';

export type StackMode = 'under' | 'above' | 'folded' | 'pill';
/** The steps where the notices stand above the card, which goes to the
 * stack's end (noticeRegion.css lists each; the rules test reads it). */
export const ABOVE_MODES: readonly StackMode[] = ['above', 'folded', 'pill'];

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
  /** The plan line alone (the first kept line), unscrolled. */
  first?: { top: number; bottom: number } | null;
  /** Which notices offer Undo or Redo, top to bottom: they never fold. */
  undo?: boolean[];
  /** Which of them can carry the fold in their own row ("Undo · 3 more",
   * GM r8): they hold a `MORE_SLOT_ATTR` mark. */
  host?: boolean[];
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
  /** How far the open log's body may give way: its height less its floor
   * of header and 2 rows (0 for a closed log); and how much more its
   * collapse to its header frees (0 when it may not collapse: closed, or
   * reopened by the person while the card shows). Docked, or floating. */
  logSpare?: number;
  logCollapse?: number;
  /** The card, when one shows. */
  card: CardMeasure | null;
  /** An undocked Agent log's box (window coordinates), when one shows. */
  floating?: { top: number; bottom: number; left: number; right: number } | null;
  /** The card's column (window x), for the floating log's test; with no
   * card, the notices' own column. */
  column?: { left: number; right: number } | null;
  /** With no card, the notices alone (GM r8: they clear the log too). */
  notices?: { items: number[]; gap: number } | null;
}

export interface StackPlace {
  aboveLog: boolean;
  /** How far the stack is lifted off the region's bottom line. */
  lift: number;
  /** The card's max height, or null with no card. */
  cap: number | null;
  /** The give-way step, or null with no card. */
  mode: StackMode | null;
  /** How many notices are folded into the "more" row, and which. */
  folded: number;
  fold: boolean[];
  /** The "more" row's count, 0 while it is hidden. */
  more: number;
  /** The notice whose own row carries the count ("Moved “Hero shot” · Undo
   * · 3 more", GM r8), or -1: the fold's own row shows instead. */
  moreHost: number;
  /** The person unfolded the row: it shows, aria-expanded. */
  expanded: boolean;
  /** The body is shorter than note and plan line: scroll the plan line in. */
  keepPlan: boolean;
  /** Step 3: how far the log's body gives way; step 4: it collapses. */
  squeeze: number;
  collapse: boolean;
  /** Step 5: the body is shorter than its kept lines (they scroll behind
   * the fade, the plan line kept first), and how far the card's foot then
   * crosses the log's line. */
  underFade: boolean;
  over: number;
  /** The line the stack's top stays under (a floating log's foot may lower it). */
  topLine?: number;
  /** Where the stack sits by a floating log in its column (GM r9): beside
   * it on its left or right, under or above it; null with none. */
  float?: FloatSide | null;
  /** Beside a floating log: the region's insets from the window's left and
   * right edges, so it stops short of the log on that side. */
  inset?: { left: number; right: number } | null;
}

export type FloatSide = 'left' | 'right' | 'under' | 'above';

/** The room beside a log for a region from `left` to the window's right
 * less `rightClear` (r1's rule, GM - Design, PR #216 r3 and r9): the docked
 * log clears the right edge; a floating one either edge. */
export function besideRoom(m: Pick<StackMeasure, 'viewportW' | 'gutter'>, left: number, rightClear: number): number {
  return m.viewportW - Math.max(m.gutter, rightClear) - left;
}

const ONE_LINE_PX = 20;

/** The body heights the card keeps: `full` shows the note and the plan line
 * whole; `min` the plan line alone, the note scrolled behind the top fade
 * (GM r5 2). With no plan line, the old minimum and one line. */
export function bodyFloors(card: CardMeasure): { full: number; min: number; one: number } {
  const body = card.body;
  const line = Math.min(card.line ?? ONE_LINE_PX, body);
  const least = Math.min(MIN_BODY_PX, body);
  if (!card.plan) return { full: least, min: line, one: line };
  const full = Math.min(body, Math.max(least, card.plan.bottom + FADE_PX));
  const min = Math.min(full, card.plan.bottom - card.plan.top + 2 * FADE_PX);
  // The plan line alone, whole between the two fades (step 5's floor).
  const first = card.first ?? card.plan;
  const one = Math.min(min, first.bottom - first.top + 2 * FADE_PX);
  return { full, min, one };
}

/** The "N more notices" row's words (step 1: the newest shows). */
export function moreLabel(count: number): string {
  return count === 1 ? '1 more notice' : `${count} more notices`;
}

/** The pill's words (step 2: every notice without an Undo folded). */
export function pillLabel(count: number): string {
  return count === 1 ? '1 notice' : `${count} notices`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function placeNoticeStack(m: StackMeasure, options: { expanded?: boolean } = {}): StackPlace {
  const docked = m.logClearance > 0 && m.logTop > 0;
  const beside = besideRoom(m, m.regionLeft, m.logClearance);
  const aboveLog = docked && beside < BESIDE_LOG_MIN_W;
  let base = aboveLog ? Math.max(0, Math.ceil(m.logTop - m.regionBottom)) : 0;
  const none = { folded: 0, fold: [], more: 0, moreHost: -1, expanded: false, keepPlan: false, squeeze: 0, collapse: false, underFade: false, over: 0, float: null, inset: null };
  if (!m.card) {
    // The notices alone clear a floating log in their column too (GM r8):
    // under it when they fit between its foot and the line, else above it,
    // else on the side with more room.
    const float = docked ? null : m.floating;
    const alone = m.notices;
    if (float && alone && alone.items.length && m.column && float.left < m.column.right && float.right > m.column.left) {
      const line0 = m.viewportH - m.regionBottom - base;
      const needs = sum(alone.items) + alone.gap * (alone.items.length - 1);
      const under = line0 - (float.bottom + FLOAT_GAP_PX);
      const over = float.top - FLOAT_GAP_PX - m.topLine;
      if (float.top < line0 && under < needs && (over >= needs || over > under)) {
        base = Math.max(base, Math.ceil(m.viewportH - float.top + FLOAT_GAP_PX - m.regionBottom));
      }
    }
    return { aboveLog, lift: base, cap: null, mode: null, ...none };
  }
  const card = m.card;
  const gap = card.gap ?? 8;
  const items = card.items ?? [];
  const count = items.length;
  const undo = items.map((_, index) => Boolean(card.undo?.[index]));
  // The newest notice that can carry the fold's count in its own row.
  const hostAt = items.reduce((at, _, index) => (undo[index] && card.host?.[index] ? index : at), -1);
  // Each notice and the gap over it.
  const below = sum(items) + gap * count;
  // The ways the notices can stand above the card, least folded first.
  type Rows = { mode: StackMode; fold: boolean[]; rows: number; more: number; host: number };
  const rowsOf = (mode: StackMode, fold: boolean[]): Rows => {
    const more = fold.filter(Boolean).length;
    const shown = items.reduce((total, h, index) => total + (fold[index] ? 0 : h + gap), 0);
    // An Undo notice showing carries the count in its own row: no row of its own.
    // A notice with an Undo never folds, so the host always shows.
    const host = more && hostAt >= 0 ? hostAt : -1;
    return { mode, fold, more, host, rows: shown + (more && host < 0 ? MORE_ROW_PX + gap : 0) };
  };
  const ladder: Rows[] = [rowsOf('above', items.map(() => false))];
  // Step 1: the older ones without an Undo fold under "N more notices".
  const older = items.map((_, index) => index < count - 1 && !undo[index]);
  // Step 2: every one without an Undo, the newest too: "N notices". When
  // the newest offers Undo the two are one fold, and it is the pill: every
  // notice that can fold is in it.
  const all = items.map((_, index) => !undo[index]);
  const pill = all.filter(Boolean).length;
  if (older.some(Boolean) && older.filter(Boolean).length < pill) ladder.push(rowsOf('folded', older));
  if (pill) ladder.push(rowsOf('pill', all));
  const compact = ladder[ladder.length - 1];
  const floors = bodyFloors(card);
  let topLine = m.topLine;
  // Steps 3 and 4 give the room of the log the stack sits above.
  const spare = Math.max(0, Math.floor(m.logSpare ?? 0));
  const collapseGive = Math.max(0, Math.floor(m.logCollapse ?? 0));
  let gives = aboveLog;

  // A floating log in the card's column (GM r4 6, r7, r9). 1: beside it,
  // with at least BESIDE_LOG_MIN_W on one side (r1's rule): the region stops
  // short of it there. 2: under it when the stack fits between its foot and
  // the stack's line; else above it, the log giving way at its bottom edge
  // as the docked one does; when neither fits, the side with more room, and
  // under it the stack's top then crosses the log's body, never its header.
  // 3: step 5 on that side.
  const float = docked ? null : m.floating;
  let floatSide: FloatSide | null = null;
  let inset: StackPlace['inset'] = null;
  if (float && m.column && float.left < m.column.right && float.right > m.column.left
      && float.bottom > topLine && float.top < m.viewportH - m.regionBottom - base) {
    const regionRight = Math.max(m.gutter, m.logClearance);
    const leftRoom = besideRoom(m, m.regionLeft, m.viewportW - float.left + FLOAT_GAP_PX);
    const rightRoom = besideRoom(m, Math.max(m.regionLeft, float.right + FLOAT_GAP_PX), m.logClearance);
    if (Math.max(leftRoom, rightRoom) >= BESIDE_LOG_MIN_W) {
      floatSide = leftRoom >= rightRoom ? 'left' : 'right';
      inset = floatSide === 'left'
        ? { left: Math.floor(m.regionLeft), right: Math.ceil(m.viewportW - float.left + FLOAT_GAP_PX) }
        : { left: Math.ceil(float.right + FLOAT_GAP_PX), right: Math.floor(regionRight) };
    }
  }
  if (float && !floatSide && m.column && float.left < m.column.right && float.right > m.column.left
      && float.bottom > topLine && float.top < m.viewportH - m.regionBottom - base) {
    const line0 = m.viewportH - m.regionBottom - base;
    const needs = card.chrome + floors.min + compact.rows;
    const under = line0 - (float.bottom + FLOAT_GAP_PX);
    const over = float.top - FLOAT_GAP_PX - topLine + spare + collapseGive;
    const least = card.chrome + Math.min(card.line ?? ONE_LINE_PX, card.body) + compact.rows;
    if (under >= needs || (over < needs && (under >= over || over < least))) {
      topLine = Math.max(topLine, Math.ceil(float.bottom + FLOAT_GAP_PX));
      floatSide = 'under';
    } else {
      base = Math.max(base, Math.ceil(m.viewportH - float.top + FLOAT_GAP_PX - m.regionBottom));
      gives = true;
      floatSide = 'above';
    }
  }

  // The room from the stack's line up to the top line.
  const room = m.viewportH - m.regionBottom - base - topLine;
  const logSpare = gives ? spare : 0;
  const logCollapse = gives ? collapseGive : 0;
  const place = ({ mode, fold, rows, more, host }: Rows, expanded = false): StackPlace => {
    const cap = Math.floor(room - rows);
    const keep = card.chrome + floors.min;
    const least = card.chrome + Math.min(card.line ?? ONE_LINE_PX, card.body);
    // Step 3: the log's body gives way, down to its floor; step 4: it
    // collapses to its header.
    const short = Math.max(0, Math.ceil(keep - cap));
    const squeeze = Math.min(short, logSpare);
    const collapse = short > logSpare && logCollapse > 0;
    const give = squeeze + (collapse ? logCollapse : 0);
    const room4 = cap + give;
    // Step 5: the body under its kept lines, down to one line; then the foot.
    const over = Math.max(0, Math.ceil(least - room4));
    const lift = Math.max(0, base - give - over);
    const height = Math.max(room4, least);
    return {
      aboveLog, lift, cap: height, mode, topLine, squeeze, collapse, over: Math.max(0, base - give - lift),
      underFade: height - card.chrome < floors.min,
      folded: more, fold, more, moreHost: host, expanded,
      keepPlan: height - card.chrome < floors.full,
      float: floatSide, inset,
    };
  };

  // Step 0: the notices under the card, note and plan line whole.
  if (count === 0) return place({ mode: 'under', fold: [], rows: 0, more: 0, host: -1 });
  if (room - below - card.chrome >= floors.full) return place({ mode: 'under', fold: items.map(() => false), rows: below, more: 0, host: -1 });
  // Unfolded by the person: all of them above, the row on top ("Show less"),
  // or "Show less" in the Undo notice's row.
  if (options.expanded && compact.more) {
    return place({
      mode: 'above', fold: items.map(() => false), rows: (hostAt >= 0 ? 0 : MORE_ROW_PX + gap) + below, more: compact.more, host: hostAt,
    }, true);
  }
  // Steps 1 and 2: the first way the kept lines fit with no give.
  const fits = ladder.find((rows) => room - rows.rows - card.chrome >= floors.min);
  // Then the log gives way, and last the kept lines.
  return place(fits ?? compact);
}

/** Where everything lands (window y), for the placement's invariants: the
 * card's header, plan line and footer, and each row in the stack. */
export interface StackGeometry {
  card: {
    top: number; headBottom: number; footTop: number; bottom: number;
    /** The kept lines' span, and the plan line alone, where they show. */
    plan: { top: number; bottom: number } | null;
    first: { top: number; bottom: number } | null;
  } | null;
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
  if (place.more && place.moreHost < 0) shown.push({ h: MORE_ROW_PX, kind: 'more' });
  items.forEach((h, index) => { if (!place.fold[index]) shown.push({ h, kind: 'notice' }); });
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
  let first: { top: number; bottom: number } | null = null;
  if (card.plan) {
    const tall = card.plan.bottom - card.plan.top;
    const one = card.first ?? card.plan;
    let shift: number;
    if (place.underFade) {
      // Step 5: the plan line just under the top fade (or centred when even
      // it can't clear both), the ⚠ line next in the scroll.
      const offset = Math.max(0, Math.min(FADE_PX, (visible - (one.bottom - one.top)) / 2));
      shift = headBottom + offset - one.top;
    } else if (card.plan.bottom + (card.plan.bottom < card.body ? FADE_PX : 0) <= visible) {
      // Unscrolled while it fits with the fade under it.
      shift = headBottom;
    } else {
      // Scrolled in (keepPlan): the last kept line's foot over the bottom fade.
      shift = headBottom + visible - FADE_PX - card.plan.bottom;
    }
    plan = { top: card.plan.top + shift, bottom: card.plan.top + shift + tall };
    first = { top: one.top + shift, bottom: one.bottom + shift };
  }
  return { card: { top, headBottom, plan, first, footTop: cardBottom - foot, bottom: cardBottom }, rows, line };
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
  return prev.mode !== next.mode || prev.folded !== next.folded || prev.more !== next.more || prev.collapse !== next.collapse
    || prev.moreHost !== next.moreHost
    // GM r9: beside a floating log, under it or above it, and the inset
    // beside it as the log is dragged or the window resized.
    || (prev.float ?? null) !== (next.float ?? null)
    || prev.inset?.left !== next.inset?.left || prev.inset?.right !== next.inset?.right;
}

function px(value: string): number {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

/** The notices in the stack, top to bottom (the card is not one). */
function noticeItems(stack: HTMLElement): HTMLElement[] {
  return [...stack.querySelectorAll<HTMLElement>('[data-notice-slot] > *')].filter((item) => !item.hasAttribute(SHRINK_ATTR));
}

/** A notice that offers Undo or Redo (GM r7: it never folds). */
export function offersUndo(item: HTMLElement): boolean {
  if (item.hasAttribute(UNDO_ATTR) || item.querySelector(`[${UNDO_ATTR}]`)) return true;
  return [...item.querySelectorAll('button')].some((button) => /^(Undo|Redo)\b/.test((button.textContent ?? '').trim()));
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
  // The region and the card's column as they are with no floating log
  // beside them (GM r9): the inset a place wrote is lifted for the read,
  // so being beside the log never moves the column the log is tested
  // against. The region's sides never transition, so nothing springs.
  const inset = { left: region.style.left, right: region.style.right };
  if (inset.left || inset.right) { region.style.left = ''; region.style.right = ''; }
  const rect = region.getBoundingClientRect();
  const naturalCard = stack.querySelector<HTMLElement>(`[${SHRINK_ATTR}]`)?.offsetWidth ?? 0;
  if (inset.left || inset.right) { region.style.left = inset.left; region.style.right = inset.right; }
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
    let first: CardMeasure['first'] = null;
    if (kept.length) {
      const from = scroller.getBoundingClientRect().top;
      const boxes = kept.map((element) => element.getBoundingClientRect());
      const at = (y: number) => Math.round((y - from) / scale + scroller.scrollTop);
      plan = { top: at(Math.min(...boxes.map((b) => b.top))), bottom: at(Math.max(...boxes.map((b) => b.bottom))) };
      first = { top: at(boxes[0].top), bottom: at(boxes[0].bottom) };
    }
    shrink = {
      chrome: Math.max(0, card.offsetHeight - body.offsetHeight),
      body: scroller.scrollHeight,
      foot: foot ? Math.max(0, Math.round((cardRect.bottom - foot.getBoundingClientRect().top) / scale)) : 0,
      line: px(getComputedStyle(scroller).lineHeight) || ONE_LINE_PX,
      items: noticeItems(stack).map((item) => item.offsetHeight),
      undo: noticeItems(stack).map(offersUndo),
      host: noticeItems(stack).map((item) => item.querySelector(`[${MORE_SLOT_ATTR}]`) !== null),
      gap: px(getComputedStyle(stack).rowGap) || 8,
      plan,
      first,
    };
    // Centred in the region (its stack is), at its width there with no inset.
    const width = inset.left || inset.right ? naturalCard : card.offsetWidth || cardRect.width;
    column = width > 0
      ? { left: rect.left + (rect.width - width) / 2, right: rect.left + (rect.width + width) / 2 }
      : { left: cardRect.left, right: cardRect.right };
  }
  // With no card, the notices alone and their column (GM r8: they clear a
  // floating log too).
  let notices: StackMeasure['notices'] = null;
  if (!shrink) {
    const items = noticeItems(stack).filter((item) => !item.hasAttribute(FOLD_ATTR) && item.offsetHeight > 0);
    if (items.length) {
      notices = { items: items.map((item) => item.offsetHeight), gap: px(getComputedStyle(stack).rowGap) || 8 };
      const boxes = items.map((item) => item.getBoundingClientRect());
      column = { left: Math.min(...boxes.map((b) => b.left)), right: Math.max(...boxes.map((b) => b.right)) };
    }
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
    // AgentLog writes the log's height without any give, its floor, and what
    // its collapse frees while it may collapse.
    logSpare: Math.max(0, px(root.getPropertyValue('--agent-log-natural-h')) - px(root.getPropertyValue('--agent-log-floor'))),
    logCollapse: px(root.getPropertyValue(LOG_COLLAPSE_VAR)),
    card: shrink,
    floating: floatBottom > 0 ? {
      top: floatTop, bottom: floatBottom,
      left: px(root.getPropertyValue('--agent-log-float-left')), right: px(root.getPropertyValue('--agent-log-float-right')),
    } : null,
    column,
    notices,
  };
}

type Box = { top: number; bottom: number; height: number; left?: number };
const resting = new WeakMap<Element, Box>();
const gliding = new WeakMap<Element, Animation>();

function box(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, height: rect.height, left: rect.left };
}

/** The region's insets beside a floating log, or its own (CSS) with none. */
function setInset(region: HTMLElement, inset: StackPlace['inset']): void {
  const left = inset ? `${inset.left}px` : '';
  const right = inset ? `${inset.right}px` : '';
  if (region.style.left !== left) region.style.left = left;
  if (region.style.right !== right) region.style.right = right;
}

/** Its box in the layout, without the transform it draws with now (a glide's
 * translate, an entrance's scale about its centre). */
export function layoutBox(element: Element): Box {
  const rect = element.getBoundingClientRect();
  const seen = { top: rect.top, bottom: rect.bottom, height: rect.height, left: rect.left };
  const matrix = /^matrix\(([^)]+)\)$/.exec(getComputedStyle(element).transform || '');
  if (!matrix) return seen;
  const [a = 1, , , d = 1, e = 0, f = 0] = matrix[1].split(',').map((part) => Number.parseFloat(part));
  const scale = d || 1;
  const height = seen.height / scale;
  const top = seen.top - f - (height * (1 - scale)) / 2;
  const scaleX = a || 1;
  const width = rect.width / scaleX;
  const left = seen.left - e - (width * (1 - scaleX)) / 2;
  return { top, bottom: top + height, height, left };
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
    // Sideways too, beside a floating log or back (GM r9).
    const dx = from.left !== undefined && to.left !== undefined ? from.left - to.left : 0;
    if ((Math.abs(dy) < 1 && Math.abs(dx) < 1) || typeof element.animate !== 'function') continue;
    const move = element.animate(
      [{ transform: `translate(${Math.round(dx)}px, ${Math.round(dy)}px)` }, { transform: 'translate(0, 0)' }],
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
  // Beside a floating log (GM r9): the region stops short of it.
  setInset(region, place.inset ?? null);
  region.style.setProperty('--notice-stack-lift', `${place.lift}px`);
  if (card && place.cap !== null) card.style.setProperty('--notice-card-cap', `${place.cap}px`);
  if (place.mode) region.dataset.noticeMode = place.mode;
  else delete region.dataset.noticeMode;
  // A folded notice is inert too: no focus (the dialogs' focus order skips
  // it, lib/modalFocus.ts) and nothing a screen reader walks into.
  items.forEach((item, index) => {
    if (place.fold[index]) {
      item.setAttribute(FOLD_ATTR, '');
      item.setAttribute('inert', '');
      resting.delete(item);
    } else if (item.hasAttribute(FOLD_ATTR)) {
      item.removeAttribute(FOLD_ATTR);
      item.removeAttribute('inert');
    }
  });
  // GM r8: with an Undo notice showing, the count rides in its row.
  const host = place.more && place.moreHost >= 0 ? items[place.moreHost] ?? null : null;
  items.forEach((item) => {
    if (item === host) item.setAttribute(MORE_HOST_ATTR, '');
    else item.removeAttribute(MORE_HOST_ATTR);
  });
  setNoticeMore({ host, count: place.more, expanded: place.expanded });
  const ownRow = place.more > 0 && !host;
  if (ownRow) region.setAttribute(MORE_SHOWN_ATTR, '');
  else region.removeAttribute(MORE_SHOWN_ATTR);
  if (more) {
    more.hidden = !ownRow;
    more.textContent = !ownRow ? '' : place.expanded ? SHOW_LESS : place.mode === 'pill' ? pillLabel(place.more) : moreLabel(place.more);
    more.setAttribute('aria-expanded', String(place.expanded));
  }
  // The spring is off for this frame: read the layout so the jump lands now.
  void stack.offsetHeight;
  // GM r5 2: the body keeps its plan line; the note scrolls behind its fade.
  const scroller = card ? scrollerOf(card) : null;
  const kept = card ? [...card.querySelectorAll<HTMLElement>(`[${KEEP_ATTR}]`)] : [];
  if (place.keepPlan && scroller && kept.length) {
    const view = scroller.getBoundingClientRect();
    if (place.underFade) {
      // Step 5 (GM r7): the plan line first, just under the top fade, the
      // ⚠ line next in the scroll.
      const line = kept[0].getBoundingClientRect();
      const offset = Math.max(0, Math.min(FADE_PX, (view.height - line.height) / 2));
      scroller.scrollTop += Math.round(line.top - (view.top + offset));
    } else {
      // The last kept line's foot just over the bottom fade: whole, and any
      // line the edge cuts sits under a fade (GM r6).
      const foot = Math.max(...kept.map((element) => element.getBoundingClientRect().bottom));
      const short = foot - (view.bottom - FADE_PX);
      if (short > 0) scroller.scrollTop += Math.ceil(short);
    }
  }
  // Step 3: the log's body gives way by the squeeze, or grows back (step 4,
  // the collapse, is the region's ask of uiStore).
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
