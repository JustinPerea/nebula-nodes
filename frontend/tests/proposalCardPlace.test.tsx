import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ABOVE_MODES,
  BESIDE_LOG_MIN_W,
  FADE_PX,
  FLOAT_GAP_PX,
  FOLD_ATTR,
  GLIDE_MS,
  JUMP_ATTR,
  MIN_BODY_PX,
  MORE_HOST_ATTR,
  MORE_ROW_PX,
  MORE_SHOWN_ATTR,
  MORE_SLOT_ATTR,
  LOG_SQUEEZE_VAR,
  besideRoom,
  placedCard,
  bodyScrollTop,
  easingPeak,
  inWindow,
  besideCard,
  lineStop,
  narrowMinimum,
  textLines,
  type BodyLine,
  type CardProbe,
  SHOW_LESS,
  applyNoticeStack,
  bodyFloors,
  glideStack,
  layoutBox,
  measureNoticeStack,
  moreLabel,
  offersUndo,
  pillLabel,
  placeNoticeStack,
  stackGeometry,
  stackJumps,
  stepChanged,
  type StackMeasure,
  type StackPlace,
} from '../src/lib/noticeStackPlace';
import { getNoticeMore } from '../src/lib/noticeMore';
import { NOTICE_TOP_LINE_ATTR, TOP_BAR_ATTR, noticeTopLimit } from '../src/lib/bottomBar';

/**
 * GM - Design, PR #216 r3: "the notice region is one stack, moves as one;
 * the card is the only part that shrinks."
 * - Under 400 px beside the docked Agent log, the whole stack goes above the
 *   log at the region's full width (the card up to 600), card on top.
 * - The region clears the left tool rail as it clears the log (r2 bug 3).
 * - The card's cap is the region's room less the notices under it; its body
 *   keeps ~60 px; when even that doesn't fit, the card comes down over the
 *   log's top edge, and its top never passes the inset.
 * jsdom lays nothing out: the cases below run the placement on the live
 * check's measured numbers (docs/notes), and the rules are read as text.
 */
const CARD_CSS = readFileSync(join(__dirname, '../src/styles/canvasProposals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const REGION_CSS = readFileSync(join(__dirname, '../src/styles/noticeRegion.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const RAIL_CSS = readFileSync(join(__dirname, '../src/styles/workspace-rail.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const REGION = readFileSync(join(__dirname, '../src/components/NoticeRegion.tsx'), 'utf8');

function rule(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(css);
  if (!match) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(match[1].split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const colon = part.indexOf(':');
    return [part.slice(0, colon).trim(), part.slice(colon + 1).replace(/\s+/g, ' ').trim()];
  }));
}

// The live layout in Slava Restraint (round 2's measurements): the region's
// bottom line 80 px up, the rail's clearance 70, a docked log 340 wide plus
// its 8 px gap and 198 tall, the top inset 72, one notice 46 + its 8 px gap.
const CHROME = 34 + 55 + 2;
function measure(over: Partial<StackMeasure> & { logHeight?: number; logOpen?: boolean }): StackMeasure {
  const { logHeight = 198, logOpen = true, ...rest } = over;
  const viewportH = rest.viewportH ?? 900;
  return {
    viewportW: 420, viewportH, gutter: 16, regionLeft: 70, regionBottom: 80,
    logClearance: logOpen ? 348 : 0, logTop: logOpen ? logHeight + 8 : 0, topLine: 72,
    card: { chrome: CHROME, body: 400 },
    ...rest,
  };
}

describe('the notice stack and the Agent log', () => {
  it.each([
    ['420x900, log open, 1 notice', measure({ card: { chrome: CHROME, body: 400, items: [46] } })],
    ['420x640', measure({ viewportH: 640 })],
    ['420x560', measure({ viewportH: 560, card: { chrome: CHROME, body: 600, items: [46] } })],
    ['900, Show all, 2 notices', measure({ viewportW: 900, card: { chrome: CHROME, body: 1200, items: [46, 46] } })],
    ['the log dragged up', measure({ viewportH: 700, logHeight: 492, card: { chrome: CHROME, body: 600, items: [46] } })],
    ['the selection toolbar showing', measure({ topLine: 150, card: { chrome: CHROME, body: 900, items: [46] } })],
  ])('%s: the card top is at or below the inset and its footer fully shows', (_name, m) => {
    const place = placeNoticeStack(m);
    const { card } = stackGeometry(m, place);
    expect(place.squeeze).toBe(0);
    expect(card!.top).toBeGreaterThanOrEqual(m.topLine);
    expect(card!.bottom).toBeLessThanOrEqual(m.viewportH);
    // Header, at least one line of body and footer always show.
    expect(card!.bottom - card!.top).toBeGreaterThanOrEqual(CHROME + 20);
  });

  it('under 400 px beside the log, the whole stack goes above it; at 400 it stays beside', () => {
    const narrow = placeNoticeStack(measure({ card: null }));
    expect(narrow.aboveLog).toBe(true);
    // Lifted to the log's top line, notices with it (no card needed).
    expect(narrow.lift).toBe(198 + 8 - 80);
    const room = (width: number) => width - 348 - 70;
    expect(placeNoticeStack(measure({ viewportW: 348 + 70 + BESIDE_LOG_MIN_W })).aboveLog).toBe(false);
    expect(room(348 + 70 + BESIDE_LOG_MIN_W - 1)).toBe(399);
    expect(placeNoticeStack(measure({ viewportW: 348 + 70 + BESIDE_LOG_MIN_W - 1 })).aboveLog).toBe(true);
    // The rule counts the room after both clearances, the rail's and the log's (review 1 LOW-4).
    expect(placeNoticeStack(measure({ viewportW: 348 + 16 + BESIDE_LOG_MIN_W, regionLeft: 70 })).aboveLog).toBe(true);
    expect(placeNoticeStack(measure({ viewportW: 348 + 16 + BESIDE_LOG_MIN_W, regionLeft: 16 })).aboveLog).toBe(false);
    // No docked log: nothing to go above.
    expect(placeNoticeStack(measure({ logOpen: false })).aboveLog).toBe(false);
    expect(placeNoticeStack(measure({ logOpen: false })).lift).toBe(0);
  });

  it('caps the card at the room less the notices under it (review 1 HIGH-1)', () => {
    const alone = placeNoticeStack(measure({ viewportW: 900 }));
    const withTwo = placeNoticeStack(measure({ viewportW: 900, card: { chrome: CHROME, body: 400, items: [46, 46] } }));
    expect(withTwo.mode).toBe('under');
    expect(alone.cap! - withTwo.cap!).toBe(2 * (46 + 8));
  });

  it('keeps the body at its minimum and the card under the inset when the room allows', () => {
    const m = measure({ viewportH: 700, logHeight: 400, card: { chrome: CHROME, body: 600 } });
    const { card } = stackGeometry(m, placeNoticeStack(m));
    expect(card!.top).toBeGreaterThanOrEqual(m.topLine);
    expect(card!.bottom).toBeLessThanOrEqual(700 - 400);
  });
});
// GM - Design, PR #216 r5-r7, on the live check's numbers (round 3d, 420
// wide, the log open): region line 81 up, the log's top line 268 up (its
// height 180 with no give, its floor of header and 2 rows 91, its header
// alone 44 collapsed), the top line 116 (the selection toolbar's empty Panel
// keeps its room, so a selection never moves the card), header 34 + footer
// 53 + borders, the plan line 77-110 and the first ⚠ row's foot at 142 in a
// 198 px body, notices 46 tall with 8 px gaps.
const CLOSED_LOG = 44;
const LIVE = {
  viewportW: 420, viewportH: 560, gutter: 16, regionLeft: 64, regionBottom: 81,
  logClearance: 348, logTop: 268, topLine: 116, logSpare: 180 - 91, logCollapse: 91 - CLOSED_LOG,
};
const PLAN = { top: 77, bottom: 142 };
const FIRST = { top: 77, bottom: 110 };
const LIVE_CARD = { chrome: 89, body: 198, foot: 54, line: 20, gap: 8, plan: PLAN, first: FIRST };
const at = (viewportH: number, count: number, over: Partial<StackMeasure> = {}, undo?: boolean[]): StackMeasure => ({
  ...LIVE, viewportH, card: { ...LIVE_CARD, items: Array(count).fill(46), ...(undo ? { undo } : {}) }, ...over,
});
/** The room from the log's line to the top line. */
const roomAt = (viewportH: number) => viewportH - LIVE.logTop - LIVE.topLine;
const BASE = LIVE.logTop - LIVE.regionBottom;
/** Header and footer, and the kept lines between two fades. */
const KEEP = 89 + (142 - 77) + 2 * FADE_PX;

describe('the card body keeps its kept lines (GM r5-r7)', () => {
  it('full: note and kept lines whole, the fade under them; min: the kept lines alone between two fades; one: the plan line alone', () => {
    expect(bodyFloors(LIVE_CARD)).toEqual({ full: 142 + FADE_PX, min: 65 + 2 * FADE_PX, one: 33 + 2 * FADE_PX });
    // Without a ⚠ row, the plan line alone.
    expect(bodyFloors({ ...LIVE_CARD, plan: FIRST, first: FIRST })).toEqual({ full: 110 + FADE_PX, min: 33 + 2 * FADE_PX, one: 33 + 2 * FADE_PX });
    // A short body needs no more than itself.
    expect(bodyFloors({ ...LIVE_CARD, body: 90, plan: { top: 40, bottom: 80 }, first: null })).toEqual({ full: 90, min: 40 + 2 * FADE_PX, one: 40 + 2 * FADE_PX });
    // No plan line: the old minimum, and one line.
    expect(bodyFloors({ chrome: 89, body: 198 })).toEqual({ full: MIN_BODY_PX, min: 20, one: 20 });
  });
});

describe('the give-way order (GM r5-r7)', () => {
  it('0: the notices stay under the card while its body keeps note and kept lines whole', () => {
    const m = at(700, 1);
    const place = placeNoticeStack(m);
    expect(place).toMatchObject({ mode: 'under', cap: roomAt(700) - 54, folded: 0, more: 0, keepPlan: false, squeeze: 0, collapse: false, underFade: false, over: 0 });
    const { card, rows } = stackGeometry(m, place);
    expect(rows[0].top).toBe(card!.bottom + 8);
  });

  it('GM r5 1 holds no more room than 0, so step 0\'s floor goes straight on: the notices move above', () => {
    const edge = LIVE.logTop + LIVE.topLine + 108 + 89 + 158;
    expect(placeNoticeStack(at(edge, 2)).mode).toBe('under');
    const m = at(edge - 1, 2);
    const place = placeNoticeStack(m);
    expect(place).toMatchObject({ mode: 'above', cap: roomAt(edge - 1) - 108, keepPlan: true, squeeze: 0, over: 0 });
    // Over the canvas, under the top line, the newest nearest the card.
    const { card, rows } = stackGeometry(m, place);
    expect(card!.bottom).toBe(edge - 1 - LIVE.logTop);
    expect(rows.map((row) => row.kind)).toEqual(['notice', 'notice']);
    expect(rows[1].bottom + 8).toBe(card!.top);
    expect(rows[0].top).toBeGreaterThanOrEqual(LIVE.topLine);
  });

  it('1: above, the body gives up the note before the kept lines', () => {
    const lowest = LIVE.logTop + LIVE.topLine + 108 + KEEP;
    const place = placeNoticeStack(at(lowest, 2));
    expect(place).toMatchObject({ mode: 'above', cap: KEEP, squeeze: 0 });
    expect(placeNoticeStack(at(lowest - 1, 2)).mode).toBe('folded');
  });

  it('1: no room above for them all, the older ones fold into one row over the newest', () => {
    const m = at(670, 2);
    const place = placeNoticeStack(m);
    expect(place).toMatchObject({ mode: 'folded', folded: 1, fold: [true, false], more: 1, expanded: false, cap: roomAt(670) - (MORE_ROW_PX + 8 + 46 + 8), squeeze: 0, over: 0 });
    const { card, rows } = stackGeometry(m, place);
    expect(rows.map((row) => row.kind)).toEqual(['more', 'notice']);
    expect(rows[1].bottom + 8).toBe(card!.top);
    expect(placeNoticeStack(at(670, 4))).toMatchObject({ mode: 'folded', folded: 3, more: 3, fold: [true, true, true, false] });
    expect(moreLabel(1)).toBe('1 more notice');
    expect(moreLabel(3)).toBe('3 more notices');
  });

  it('2: then every notice without an Undo folds into the pill, "N notices"', () => {
    // 3 notices at 420x640: folded leaves the body 14 px short of its kept
    // lines; the pill (32 + 8) leaves it whole, with no give.
    expect(roomAt(640) - 94 - 89).toBeLessThan(KEEP - 89);
    const m = at(640, 3);
    const place = placeNoticeStack(m);
    expect(place).toMatchObject({ mode: 'pill', folded: 3, more: 3, fold: [true, true, true], squeeze: 0, collapse: false, underFade: false, cap: roomAt(640) - 40 });
    expect(stackGeometry(m, place).rows.map((row) => row.kind)).toEqual(['more']);
    expect(pillLabel(1)).toBe('1 notice');
    expect(pillLabel(4)).toBe('4 notices');
    // One notice: nothing older to fold, so it goes straight to the pill.
    expect(placeNoticeStack(at(600, 1))).toMatchObject({ mode: 'pill', fold: [true], more: 1 });
  });

  it('2: a notice with an Undo never folds, in step 1 or step 2', () => {
    // The newest offers Undo: steps 1 and 2 are one fold, the pill ("2
    // notices", the Undo notice whole under it), and then the log gives way.
    const newest = at(640, 3, {}, [false, false, true]);
    const held = placeNoticeStack(newest);
    expect(held).toMatchObject({ mode: 'pill', fold: [true, true, false], more: 2 });
    expect(held.squeeze).toBeGreaterThan(0);
    expect(stackGeometry(newest, held).rows.map((row) => row.kind)).toEqual(['more', 'notice']);
    // With the room for step 1 it is still the pill, all that can fold in it.
    expect(placeNoticeStack(at(670, 3, {}, [false, false, true]))).toMatchObject({ mode: 'pill', fold: [true, true, false], squeeze: 0 });
    // An older one offers Undo, with the room for step 1: it stays whole over the newest.
    expect(placeNoticeStack(at(720, 3, {}, [false, true, false]))).toMatchObject({ mode: 'folded', fold: [true, false, false], more: 1, squeeze: 0 });
    // Every one offers Undo: nothing folds.
    expect(placeNoticeStack(at(640, 2, {}, [true, true]))).toMatchObject({ mode: 'above', folded: 0, more: 0 });
    // An older one offers Undo: step 1 folds the oldest only, step 2 the newest too.
    const older = at(640, 3, {}, [false, true, false]);
    const place = placeNoticeStack(older);
    expect(place).toMatchObject({ mode: 'pill', fold: [true, false, true], more: 2 });
    expect(stackGeometry(older, place).rows.map((row) => row.kind)).toEqual(['more', 'notice']);
    // Unfolded, every one shows.
    expect(placeNoticeStack(older, { expanded: true })).toMatchObject({ mode: 'above', fold: [false, false, false], more: 2, expanded: true });
  });

  it('with an Undo notice showing, the fold\'s count rides in its own row: no 40 px row of its own (GM r8)', () => {
    // 420x640, 3 notices, the newest with an Undo that can carry "2 more".
    const plain = at(640, 3, {}, [false, false, true]);
    const hosted: StackMeasure = { ...plain, card: { ...plain.card!, host: [false, false, true] } };
    const before = placeNoticeStack(plain);
    const place = placeNoticeStack(hosted);
    expect(place).toMatchObject({ mode: 'pill', fold: [true, true, false], more: 2, moreHost: 2, squeeze: 0 });
    // The row's 40 px go to the card.
    expect(place.cap! - before.cap!).toBeGreaterThanOrEqual(MORE_ROW_PX + 8 - before.squeeze - 1);
    expect(before.moreHost).toBe(-1);
    const { card, rows } = stackGeometry(hosted, place);
    expect(rows.map((row) => row.kind)).toEqual(['notice']);
    expect(rows[0].bottom + 8).toBe(card!.top);
    // Unfolded it still rides there ("Show less"), every notice shown.
    const open = placeNoticeStack(hosted, { expanded: true });
    expect(open).toMatchObject({ mode: 'above', fold: [false, false, false], more: 2, moreHost: 2, expanded: true });
    expect(stackGeometry(hosted, open).rows.map((row) => row.kind)).toEqual(['notice', 'notice', 'notice']);
    // Unfolded too, the row's room goes to the card.
    const openPlain = placeNoticeStack(plain, { expanded: true });
    expect(openPlain.moreHost).toBe(-1);
    expect(open.cap! - openPlain.cap!).toBe(MORE_ROW_PX + 8);
    // Only a notice with an Undo hosts it, the newest such.
    const two = { ...plain, card: { ...plain.card!, undo: [false, true, true], host: [false, true, true] } };
    expect(placeNoticeStack(two)).toMatchObject({ moreHost: 2 });
    const notUndo = { ...plain, card: { ...plain.card!, undo: [false, false, false], host: [false, false, true] } };
    expect(placeNoticeStack(notUndo).moreHost).toBe(-1);
    // An older one with an Undo never folds, so it carries the count.
    const folded = { ...plain, card: { ...plain.card!, undo: [false, true, false], host: [false, true, false] } };
    const older = placeNoticeStack(folded);
    expect(older.moreHost).toBe(1);
    expect(older.fold[1]).toBe(false);
    // Above with nothing folded: no host.
    const roomy = { ...hosted, viewportH: 760 };
    expect(placeNoticeStack(roomy)).toMatchObject({ mode: 'above', more: 0, moreHost: -1 });
    // Nothing folded: no host either.
    expect(placeNoticeStack({ ...hosted, viewportH: 1400 })).toMatchObject({ more: 0, moreHost: -1 });
  });

  it('unfolded on click: every notice above the card under the row, until it folds again', () => {
    const m = at(670, 3);
    const place = placeNoticeStack(m, { expanded: true });
    // The row counts what the pill held.
    expect(place).toMatchObject({ mode: 'above', folded: 3, more: 3, expanded: true, fold: [false, false, false] });
    const { rows } = stackGeometry(m, place);
    expect(rows.map((row) => row.kind)).toEqual(['more', 'notice', 'notice', 'notice']);
    expect(placeNoticeStack(at(900, 3), { expanded: true })).toMatchObject({ more: 0, expanded: false });
  });

  it('3: past step 2 the log\'s body gives way, down to its floor', () => {
    // No notice at 420x560: 10 px of the log's body.
    expect(placeNoticeStack(at(560, 0))).toMatchObject({ mode: 'under', cap: KEEP, squeeze: KEEP - roomAt(560), collapse: false, underFade: false, over: 0 });
    // Two: the pill, and the log gives 50.
    const two = placeNoticeStack(at(560, 2));
    expect(two).toMatchObject({ mode: 'pill', cap: KEEP, squeeze: KEEP + 40 - roomAt(560), collapse: false, underFade: false, over: 0 });
    expect(two.lift).toBe(BASE - two.squeeze);
    // Beside the log (wide), nothing to give.
    expect(placeNoticeStack(at(560, 2, { viewportW: 1440 })).squeeze).toBe(0);
  });

  it('4: past its floor the log collapses to its header; only then do the kept lines go under the fade', () => {
    const short = (h: number) => KEEP + 40 - roomAt(h);
    // 420x500, 2 notices: 110 short, more than the body's 89.
    expect(short(500)).toBe(110);
    const collapsed = placeNoticeStack(at(500, 2));
    expect(collapsed).toMatchObject({ mode: 'pill', squeeze: LIVE.logSpare, collapse: true, underFade: false, over: 0 });
    expect(collapsed.lift).toBe(BASE - LIVE.logSpare - LIVE.logCollapse);
    expect(collapsed.cap).toBe(roomAt(500) - 40 + LIVE.logSpare + LIVE.logCollapse);
    // Past that too (420x470): the body under its kept lines.
    expect(placeNoticeStack(at(470, 2))).toMatchObject({ collapse: true, underFade: true, over: 0 });
    // A log the person reopened over the card's collapse (no collapse offered): step 5 at once.
    expect(placeNoticeStack(at(500, 2, { logCollapse: 0 }))).toMatchObject({ squeeze: LIVE.logSpare, collapse: false, underFade: true });
    // A log with no give at all: the body goes under the fade, down to one line, then the foot.
    const stiff = placeNoticeStack(at(560, 2, { logSpare: 0, logCollapse: 0 }));
    expect(stiff).toMatchObject({ squeeze: 0, collapse: false, underFade: true, cap: roomAt(560) - 40 });
    const tight = placeNoticeStack(at(460, 2, { logSpare: 0, logCollapse: 0 }));
    expect(tight).toMatchObject({ underFade: true, cap: 89 + 20, over: 89 + 20 - (roomAt(460) - 40) });
    // One line of body, shorter than the plan line: the plan line from the body's top.
    const { card } = stackGeometry(at(460, 2, { logSpare: 0, logCollapse: 0 }), tight);
    expect(card!.first!.top).toBe(card!.headBottom);
  });

  it('5: under its kept lines, the plan line shows whole first, the ⚠ line next in the scroll', () => {
    const m = at(470, 2);
    const place = placeNoticeStack(m);
    const { card } = stackGeometry(m, place);
    const body = place.cap! - 89;
    expect(body).toBeLessThan(65 + 2 * FADE_PX);
    expect(body).toBeGreaterThanOrEqual(33 + 2 * FADE_PX);
    expect(card!.first!.top).toBe(card!.headBottom + FADE_PX);
    expect(card!.first!.bottom).toBeLessThanOrEqual(card!.footTop - FADE_PX);
    // The ⚠ line follows it, past the bottom fade.
    expect(card!.plan!.bottom).toBeGreaterThan(card!.footTop - FADE_PX);
  });

  it('a body shorter than the minimum needs no give-way (review 2 NIT-5)', () => {
    const line = LIVE.viewportH - LIVE.logTop;
    const m: StackMeasure = { ...LIVE, topLine: line - 54 - (89 + 30), card: { ...LIVE_CARD, body: 30, plan: null, first: null, items: [46] } };
    const place = placeNoticeStack(m);
    expect(place.mode).toBe('under');
    expect(place.cap).toBe(89 + 30);
  });

  it('clears a floating log in the card\'s column: under it with room, else above it (GM r4 6)', () => {
    const base = { ...LIVE, viewportH: 900, logClearance: 0, logTop: 0, column: { left: 64, right: 404 } };
    const card = { ...LIVE_CARD };
    const high = placeNoticeStack({ ...base, card, floating: { top: 120, bottom: 300, left: 65, right: 403 } });
    expect(high.topLine).toBe(300 + FLOAT_GAP_PX);
    expect(high.lift).toBe(0);
    // GM r11: under it first, its body giving way to header and 2 rows and
    // then its header, held at its top edge; before above it, even with
    // room there.
    const low = placeNoticeStack({ ...base, card, floating: { top: 500, bottom: 760, left: 65, right: 403 } });
    expect(low).toMatchObject({ float: 'under', lift: 0, squeeze: LIVE.logSpare, collapse: true, hold: 'top', underFade: false });
    expect(low.topLine).toBe(760 + FLOAT_GAP_PX - LIVE.logSpare - LIVE.logCollapse);
    // Not even its header's room under it: above it, with no give.
    const lower = placeNoticeStack({ ...base, card, floating: { top: 560, bottom: 800, left: 65, right: 403 } });
    expect(lower).toMatchObject({ float: 'above', lift: 900 - 560 + FLOAT_GAP_PX - LIVE.regionBottom, squeeze: 0, collapse: false, hold: null });
    const aside = placeNoticeStack({ ...base, card, floating: { top: 500, bottom: 760, left: 600, right: 900 } });
    expect(aside.lift).toBe(0);
    expect(aside.topLine).toBe(LIVE.topLine);
    // With room, a floating log never gives way.
    expect(high).toMatchObject({ squeeze: 0, collapse: false, hold: null });
  });

  it('a floating log gives way as the docked one does when the stack sits above it (GM r7)', () => {
    // 420x560, a floating log at 300-480: 123 px under it is short; above,
    // 176 and its give hold the card and the pill.
    const m: StackMeasure = {
      ...at(640, 2), logClearance: 0, logTop: 0, column: { left: 64, right: 404 },
      floating: { top: 300, bottom: 480, left: 65, right: 403 },
    };
    const place = placeNoticeStack(m);
    const short = KEEP + 40 - (300 - FLOAT_GAP_PX - LIVE.topLine);
    expect(place).toMatchObject({ mode: 'pill', aboveLog: false, squeeze: short, collapse: false, underFade: false });
    // The stack's line comes down with the log's top, by the give.
    expect(place.lift).toBe(640 - 300 + FLOAT_GAP_PX - LIVE.regionBottom - short);
    // Under it, it never gives (it is held at its bottom edge).
    const under = placeNoticeStack({ ...m, viewportH: 900, floating: { top: 120, bottom: 300, left: 65, right: 403 } });
    expect(under).toMatchObject({ squeeze: 0, collapse: false, topLine: 300 + FLOAT_GAP_PX });
  });

  it('past its floor a floating log collapses to its header too, as the docked one (GM r8 3)', () => {
    // 420x560, a floating log at 240-480: above it 116 px, short of the card
    // and the pill by 110, more than its body's 89.
    const m: StackMeasure = {
      ...at(560, 2), logClearance: 0, logTop: 0, column: { left: 64, right: 404 },
      floating: { top: 240, bottom: 480, left: 65, right: 403 },
    };
    const place = placeNoticeStack(m);
    expect(place).toMatchObject({ mode: 'pill', aboveLog: false, squeeze: LIVE.logSpare, collapse: true, underFade: false });
    expect(place.lift).toBe(Math.ceil(560 - 240 + FLOAT_GAP_PX - LIVE.regionBottom) - LIVE.logSpare - LIVE.logCollapse);
    // Off the card's column it never gives.
    expect(placeNoticeStack({ ...m, floating: { top: 240, bottom: 480, left: 600, right: 900 } })).toMatchObject({ squeeze: 0, collapse: false });
  });

  it('with no card, the notices alone clear a floating log in their column (GM r8 4)', () => {
    const base: StackMeasure = { ...LIVE, viewportH: 640, logClearance: 0, logTop: 0, card: null, column: { left: 64, right: 404 } };
    const notices = { items: [46, 46], gap: 8 };
    // Under the log's foot there are 640 - 81 - 528 = 31 px, short of 100;
    // above it, 300 - 8 - 116 = 176: they go above.
    const low = placeNoticeStack({ ...base, notices, floating: { top: 300, bottom: 520, left: 65, right: 403 } });
    expect(low).toMatchObject({ mode: null, lift: 640 - 300 + FLOAT_GAP_PX - LIVE.regionBottom, squeeze: 0, collapse: false });
    // Room under it: they stay.
    expect(placeNoticeStack({ ...base, notices, floating: { top: 120, bottom: 300, left: 65, right: 403 } }).lift).toBe(0);
    // Off their column, or no notices, or a docked log: nothing moves.
    expect(placeNoticeStack({ ...base, notices, floating: { top: 300, bottom: 520, left: 600, right: 900 } }).lift).toBe(0);
    expect(placeNoticeStack({ ...base, notices: null, floating: { top: 300, bottom: 520, left: 65, right: 403 } }).lift).toBe(0);
    // Neither side holds them: the side with more room.
    const tall = { ...base, notices: { items: [46, 46, 46, 46], gap: 8 }, floating: { top: 200, bottom: 520, left: 65, right: 403 } };
    // 208 px: 31 under it, 76 above, so above.
    expect(placeNoticeStack(tall).lift).toBe(640 - 200 + FLOAT_GAP_PX - LIVE.regionBottom);
    // 171 under it, 16 above: they stay under.
    expect(placeNoticeStack({ ...tall, floating: { top: 140, bottom: 380, left: 65, right: 403 } }).lift).toBe(0);
  });

  it('GM r9 1: beside a floating log with at least 400 px there (r1\'s rule), the more room first; the log gives nothing', () => {
    // 1024x640, the log at its own width (340) from the column's left edge.
    const m: StackMeasure = {
      ...at(640, 2), viewportW: 1024, logClearance: 0, logTop: 0, column: { left: 212, right: 812 },
      floating: { top: 192, bottom: 372, left: 65, right: 405 },
    };
    const right = placeNoticeStack(m);
    // 1024 - 16 - (405 + 8) = 595 on its right, nothing on its left.
    expect(besideRoom(m, 405 + FLOAT_GAP_PX, 0)).toBe(595);
    expect(right).toMatchObject({ float: 'right', inset: { left: 405 + FLOAT_GAP_PX, right: 16 }, squeeze: 0, collapse: false, lift: 0, topLine: LIVE.topLine });
    // The same log by the right edge: on its left.
    const left = placeNoticeStack({ ...m, floating: { top: 192, bottom: 372, left: 600, right: 940 } });
    expect(left).toMatchObject({ float: 'left', inset: { left: 64, right: 1024 - 600 + FLOAT_GAP_PX } });
    // r1's rule exactly: 400 is beside, 399 is not.
    const at400 = { ...m, floating: { top: 192, bottom: 372, left: 65, right: 1024 - 16 - FLOAT_GAP_PX - 400 } };
    expect(placeNoticeStack(at400).float).toBe('right');
    const at399 = { ...m, floating: { ...at400.floating, right: at400.floating.right + 1 } };
    expect(placeNoticeStack(at399).float).not.toBe('right');
    expect(placeNoticeStack(at399).inset).toBeNull();
    // And on its left: 400 from the region's left to its left less the gap.
    const left400 = { ...m, floating: { top: 192, bottom: 372, left: 64 + 400 + FLOAT_GAP_PX, right: 64 + 400 + FLOAT_GAP_PX + 340 } };
    expect(placeNoticeStack(left400)).toMatchObject({ float: 'left', inset: { left: 64, right: 1024 - left400.floating.left + FLOAT_GAP_PX } });
    const left399 = { ...m, floating: { ...left400.floating, left: left400.floating.left - 1 } };
    expect(placeNoticeStack(left399).float).not.toBe('left');
    // Out of the column, or out of the stack's height: no inset.
    expect(placeNoticeStack({ ...m, floating: { top: 192, bottom: 372, left: 830, right: 1000 } })).toMatchObject({ float: null, inset: null });
    // The docked log's test is the same function.
    expect(besideRoom(LIVE, LIVE.regionLeft, LIVE.logClearance)).toBe(420 - 348 - 64);
  });

  it('GM r9 2: with no 400 px beside it, the side of it, under or above, that holds the card; the log never moves', () => {
    // 1024x640, the log at x 300-640: 228 px on its left, 360 on its right.
    const base: StackMeasure = { ...at(640, 2), viewportW: 1024, logClearance: 0, logTop: 0, column: { left: 212, right: 812 } };
    const high = placeNoticeStack({ ...base, floating: { top: 100, bottom: 280, left: 300, right: 640 } });
    expect(high).toMatchObject({ float: 'under', inset: null, squeeze: 0, topLine: 280 + FLOAT_GAP_PX, underFade: false });
    const low = placeNoticeStack({ ...base, floating: { top: 330, bottom: 510, left: 300, right: 640 } });
    expect(low).toMatchObject({ float: 'above', inset: null, underFade: false });
  });

  it('a floating log with no room on either side: a named shortfall on the side with more room, never across the log (GM r11)', () => {
    // 420x560, a log at 150-470 that may not collapse: 91 px under it with
    // its give, 115 above it; the card and the pill need 226.
    const m: StackMeasure = {
      ...at(560, 2), logClearance: 0, logTop: 0, logCollapse: 0, column: { left: 64, right: 404 },
      floating: { top: 150, bottom: 470, left: 65, right: 403 },
    };
    const place = placeNoticeStack(m);
    expect(place).toMatchObject({ float: 'above', squeeze: LIVE.logSpare, collapse: false, underFade: true, hold: 'bottom' });
    const { card, rows } = stackGeometry(m, place);
    for (const box of [card!, ...rows]) expect(box.bottom).toBeLessThanOrEqual(150 + LIVE.logSpare - FLOAT_GAP_PX);
    // Short even of one line there: it stands up past the top line, never
    // down into the log.
    expect(place.over).toBe(0);
    expect(Math.min(...[card!, ...rows].map((box) => box.top))).toBeLessThan(LIVE.topLine);
    // As much room either side: under it.
    const even = placeNoticeStack({ ...m, floating: { top: 137, bottom: 458, left: 65, right: 403 } });
    expect(even).toMatchObject({ float: 'under', underFade: true, hold: 'top' });
    // More room under it: there, the log's bottom come up, the card under it.
    const high: StackMeasure = { ...m, floating: { top: 110, bottom: 380, left: 65, right: 403 } };
    const under = placeNoticeStack(high);
    expect(under).toMatchObject({ float: 'under', squeeze: LIVE.logSpare, collapse: false, underFade: true, hold: 'top' });
    const placed = stackGeometry(high, under);
    for (const box of [placed.card!, ...placed.rows]) expect(box.top).toBeGreaterThanOrEqual(380 - LIVE.logSpare + FLOAT_GAP_PX);
  });

  it('a layout switch lands with no spring for its frame; a give-way step glides; a notice coming or going keeps the spring', () => {
    const place = (aboveLog: boolean, mode: StackPlace['mode'] = 'under', folded = 0, more = 0): StackPlace => ({
      aboveLog, lift: 0, cap: null, mode, folded, fold: [], more, moreHost: -1, expanded: false, keepPlan: false, squeeze: 0, collapse: false, underFade: false, over: 0,
    });
    expect(stackJumps(null, { place: place(true), logTop: 206, floatTop: 0 })).toBe(false);
    expect(stackJumps({ place: place(false), logTop: 206, floatTop: 0 }, { place: place(true), logTop: 206, floatTop: 0 })).toBe(true);
    expect(stackJumps({ place: place(true), logTop: 206, floatTop: 0 }, { place: place(true), logTop: 306, floatTop: 0 })).toBe(true);
    expect(stackJumps({ place: place(true), logTop: 0, floatTop: 300 }, { place: place(true), logTop: 0, floatTop: 320 })).toBe(true);
    expect(stackJumps({ place: place(true), logTop: 206, floatTop: 0 }, { place: { ...place(true), lift: 40 }, logTop: 206, floatTop: 0 })).toBe(false);
    // The log giving way moves the stack on the spring, with the log's body.
    expect(stackJumps({ place: place(true), logTop: 206, floatTop: 0 }, { place: { ...place(true), squeeze: 40, lift: -40 }, logTop: 206, floatTop: 0 })).toBe(false);
    expect(stepChanged(null, place(true, 'above'))).toBe(false);
    expect(stepChanged(place(true), place(true, 'above'))).toBe(true);
    expect(stepChanged(place(true, 'folded', 1, 1), place(true, 'folded', 2, 2))).toBe(true);
    expect(stepChanged(place(true, 'folded', 1, 1), place(true, 'above', 0, 1))).toBe(true);
    expect(stepChanged(place(true, 'above', 0, 1), place(true, 'above', 0, 0))).toBe(true);
    // The count moving into the Undo notice's row is a step (GM r8).
    expect(stepChanged(place(true, 'pill', 2, 2), { ...place(true, 'pill', 2, 2), moreHost: 2 })).toBe(true);
    expect(stepChanged(place(true, 'folded', 2, 2), place(true, 'pill', 2, 2))).toBe(true);
    expect(stepChanged(place(true, 'pill', 2, 2), { ...place(true, 'pill', 2, 2), collapse: true })).toBe(true);
    expect(stepChanged(place(true, 'above'), { ...place(true, 'above'), cap: 300 })).toBe(false);
  });
});

/**
 * The invariants in every cell of the grid (GM r5-r7): window sizes, the
 * log open (docked), closed or floating in the card's column, 0-4 notices
 * (none with an Undo, or the newest with one), the offline banner on or off.
 * Nothing on the never-covered list is covered (the card's header and
 * footer; the log's header, docked or floating), no notice overlaps
 * another, nothing leaves the window or passes the top line. The kept lines
 * (plan line and ⚠ line) show whole: SHORT lists, by name, each cell where
 * even every step of the give-way leaves the body short of them, with its
 * numbers (the body it gets, the kept lines' need), and in those the plan
 * line still shows whole unless PLAN_SHORT lists it.
 */
/** Round 3f's 71 floating cells short of their kept lines, with the log
 * as wide as the card's column (GM r9: "don't accept yet"). */
const R3F_FLOATING_SHORT = [
  '420x560 floating 0',
  '420x560 floating 0 banner',
  '420x560 floating 1',
  '420x560 floating 1 undo',
  '420x560 floating 1 banner',
  '420x560 floating 1 banner undo',
  '420x560 floating 2',
  '420x560 floating 2 undo',
  '420x560 floating 2 banner',
  '420x560 floating 2 banner undo',
  '420x560 floating 3',
  '420x560 floating 3 undo',
  '420x560 floating 3 banner',
  '420x560 floating 3 banner undo',
  '420x560 floating 4',
  '420x560 floating 4 undo',
  '420x560 floating 4 banner',
  '420x560 floating 4 banner undo',
  '420x640 floating 0 banner',
  '420x640 floating 1',
  '420x640 floating 1 undo',
  '420x640 floating 1 banner',
  '420x640 floating 1 banner undo',
  '420x640 floating 2',
  '420x640 floating 2 undo',
  '420x640 floating 2 banner',
  '420x640 floating 2 banner undo',
  '420x640 floating 3',
  '420x640 floating 3 undo',
  '420x640 floating 3 banner',
  '420x640 floating 3 banner undo',
  '420x640 floating 4',
  '420x640 floating 4 undo',
  '420x640 floating 4 banner',
  '420x640 floating 4 banner undo',
  '768x600 floating 0',
  '768x600 floating 0 banner',
  '768x600 floating 1',
  '768x600 floating 1 undo',
  '768x600 floating 1 banner',
  '768x600 floating 1 banner undo',
  '768x600 floating 2',
  '768x600 floating 2 undo',
  '768x600 floating 2 banner',
  '768x600 floating 2 banner undo',
  '768x600 floating 3',
  '768x600 floating 3 undo',
  '768x600 floating 3 banner',
  '768x600 floating 3 banner undo',
  '768x600 floating 4',
  '768x600 floating 4 undo',
  '768x600 floating 4 banner',
  '768x600 floating 4 banner undo',
  '1024x640 floating 0',
  '1024x640 floating 0 banner',
  '1024x640 floating 1',
  '1024x640 floating 1 undo',
  '1024x640 floating 1 banner',
  '1024x640 floating 1 banner undo',
  '1024x640 floating 2',
  '1024x640 floating 2 undo',
  '1024x640 floating 2 banner',
  '1024x640 floating 2 banner undo',
  '1024x640 floating 3',
  '1024x640 floating 3 undo',
  '1024x640 floating 3 banner',
  '1024x640 floating 3 banner undo',
  '1024x640 floating 4',
  '1024x640 floating 4 undo',
  '1024x640 floating 4 banner',
  '1024x640 floating 4 banner undo',
];
// Where even every step leaves the body short of its kept lines (65 + two
// fades = 97), [the body it gets, 97]: the 420x560 window under the
// two-line offline banner with the log docked (12 px short with no Undo
// notice: 78 px of room, the log's 89 and its collapse's 47, the pill's 40;
// 26 short with one, whose row now carries the fold's count, GM r8); and a
// floating log the person left mid-column, at 30% of the height, where
// nothing fits beside it either (GM r9: under 400 px; its bottom edge stays,
// so only the room above it grows). `floating wide` is that log resized to
// the column's width: nothing is ever beside it.
const EXPECTED_SHORT: Record<string, [number, number]> = {
  '420x560 open 1 banner': [85, 108],
  '420x560 open 1 banner undo': [71, 108],
  '420x560 open 2 banner': [85, 108],
  '420x560 open 2 banner undo': [71, 108],
  '420x560 open 3 banner': [85, 108],
  '420x560 open 3 banner undo': [71, 108],
  '420x560 open 4 banner': [85, 108],
  '420x560 open 4 banner undo': [71, 108],
  '420x560 closed 1 banner': [85, 108],
  '420x560 closed 1 banner undo': [71, 108],
  '420x560 closed 2 banner': [85, 108],
  '420x560 closed 2 banner undo': [71, 108],
  '420x560 closed 3 banner': [85, 108],
  '420x560 closed 3 banner undo': [71, 108],
  '420x560 closed 4 banner': [85, 108],
  '420x560 closed 4 banner undo': [71, 108],
};
// Of those, where even the plan line alone (33 + two fades = 65) can't show
// whole, [the body, 65]: it is centred between the fades.
const EXPECTED_PLAN_SHORT: Record<string, [number, number]> = {
  '420x560 open 1 banner undo': [71, 76],
  '420x560 open 2 banner undo': [71, 76],
  '420x560 open 3 banner undo': [71, 76],
  '420x560 open 4 banner undo': [71, 76],
  '420x560 closed 1 banner undo': [71, 76],
  '420x560 closed 2 banner undo': [71, 76],
  '420x560 closed 3 banner undo': [71, 76],
  '420x560 closed 4 banner undo': [71, 76],
};

const EXPECTED_R11_OWN = [36, 35, 0, 0];
const EXPECTED_R11_WIDE = [18, 53, 0, 0];
const EXPECTED_R10_768 = 18;
/** The whole grid's floating cells (252), by step (GM r11). */
const EXPECTED_R11_ALL = [90, 162, 0, 0];

/** The live card's line boxes (round 3h, 340 px), unscrolled, as LIVE_CARD
 * places its kept lines (4 px lower: the 3e model's note margin). */
const LIVE_LINES: BodyLine[] = [[5.5, 22], [25.8, 42.2], [46, 62.5], [73.8, 87.7], [90.5, 104.5], [112.3, 125.3], [125.3, 138.3], [157.2, 171.2]]
  .map(([top, bottom]) => ({ top: top + 4, bottom: bottom + 4 }));
/** The live card measured in its narrow layout (round 3h, 1024 x 900): its
 * narrow minimum, and the card from each width up (the plan line wraps
 * once more under 290 px and once less from 380). */
const NARROW_MIN = 254;
const NARROW: Array<{ from: number; card: Omit<CardProbe, 'width'> }> = [
  { from: 254, card: { chrome: 93, body: 215, foot: 54, line: 20, plan: { top: 93, bottom: 159 }, first: { top: 93, bottom: 127 },
    lines: [[5.5, 22], [25.8, 42.3], [46.1, 62.6], [66.4, 82.9], [94.3, 108.3], [111.1, 125.1], [132.9, 145.9], [145.9, 158.9], [177.9, 191.9]].map(([top, bottom]) => ({ top, bottom })) } },
  { from: 290, card: { chrome: 93, body: 194, foot: 54, line: 20, plan: { top: 73, bottom: 138 }, first: { top: 73, bottom: 106 },
    lines: [[5.5, 22], [25.8, 42.2], [46, 62.5], [73.8, 87.7], [90.5, 104.5], [112.3, 125.3], [125.3, 138.3], [157.2, 171.2]].map(([top, bottom]) => ({ top, bottom })) } },
  { from: 380, card: { chrome: 93, body: 181, foot: 54, line: 20, plan: { top: 73, bottom: 125 }, first: { top: 73, bottom: 106 },
    lines: [[5.5, 22], [25.8, 42.2], [46, 62.5], [73.8, 87.7], [90.5, 104.5], [112.3, 125.3], [144.2, 158.2]].map(([top, bottom]) => ({ top, bottom })) } },
];
/** The card at `width` in its narrow layout, as measureNoticeStack probes it. */
const narrowAt = (width: number): CardProbe => ({ width, ...[...NARROW].reverse().find((entry) => width >= entry.from)!.card });

describe('the grid', () => {
  const SIZES: Array<[number, number]> = [[420, 560], [420, 640], [420, 760], [420, 900], [768, 600], [1024, 640], [1440, 900]];
  // `floating`: the log at its own width (layouts.css --col-right-w:
  // clamp(340px, 26vw, 460px)), its left edge at the card's column's, where
  // the person left it; `floating wide`: resized to the column's width (round
  // 3f's grid had only this one, as `floating`).
  const LOGS = ['open', 'closed', 'floating', 'floating wide'] as const;
  const COUNTS = [0, 1, 2, 3, 4];
  const FLOOR = 91;
  const SHORT: Record<string, [number, number]> = {};
  const PLAN_SHORT: Record<string, [number, number]> = {};
  /** Where the stack sits by each floating log (GM r9). */
  const SIDE: Record<string, string> = {};
  /** The width each cell's card took beside a log in its narrow layout. */
  const NARROWED: Record<string, number> = {};
  const cells = SIZES.flatMap(([w, h]) => LOGS.flatMap((log) => COUNTS.flatMap((count) => [false, true].flatMap((banner) => (count ? [false, true] : [false]).map((undo) => {
    const regionLeft = 64;
    const column = { left: regionLeft, right: regionLeft + Math.min(600, w - regionLeft - 16) };
    // The live top lines (round 3d shots): the top bars' bottom plus 8, or
    // the offline banner's bottom plus 16 (it wraps to two lines at 420).
    const topLine = banner ? (w < 600 ? 214 : 199) : (w < 600 ? 116 : 150);
    // The open log's own height (layouts.css --agent-h-open: clamp(180px, 22vh, 280px)).
    const natural = Math.min(280, Math.max(180, Math.round(h * 0.22)));
    const gives = log !== 'closed';
    const floating = log === 'floating' || log === 'floating wide';
    const logW = log === 'floating wide' ? column.right - column.left - 2 : Math.min(460, Math.max(340, Math.round(w * 0.26)));
    const m: StackMeasure = {
      viewportW: w, viewportH: h, gutter: 16, regionLeft, regionBottom: 81,
      logClearance: floating ? 0 : 348, logTop: log === 'open' ? natural + 88 : log === 'closed' ? CLOSED_LOG + 88 : 0,
      logSpare: gives ? natural - FLOOR : 0, logCollapse: gives ? FLOOR - CLOSED_LOG : 0,
      topLine,
      // The newest offers Undo, and carries the fold's count in its row (GM r8).
      card: {
        ...LIVE_CARD, items: Array(count).fill(46), lines: LIVE_LINES,
        undo: Array(count).fill(false).map((_, i) => undo && i === count - 1),
        host: Array(count).fill(false).map((_, i) => undo && i === count - 1),
      },
      floating: floating ? { top: Math.round(h * 0.3), bottom: Math.round(h * 0.3) + natural, left: column.left + 1, right: column.left + 1 + logW } : null,
      column,
    };
    // As the measure does: the rooms beside the log under 400, from the
    // card's narrow minimum, and the card at each (GM r10).
    const rooms = floating
      ? [besideRoom(m, regionLeft, w - m.floating!.left + FLOAT_GAP_PX), besideRoom(m, Math.max(regionLeft, m.floating!.right + FLOAT_GAP_PX), 0)]
      : [besideRoom(m, regionLeft, m.logClearance)];
    const narrowRooms = rooms.filter((room) => room >= NARROW_MIN && room < BESIDE_LOG_MIN_W);
    m.card = { ...m.card!, narrowMin: NARROW_MIN, probes: narrowRooms.map((room) => narrowAt(Math.floor(room))) };
    return { name: `${w}x${h} ${log} ${count}${banner ? ' banner' : ''}${undo ? ' undo' : ''}`, m, log, count, undo };
  })))));

  it('covers the whole grid', () => {
    expect(cells).toHaveLength(SIZES.length * LOGS.length * (COUNTS.length * 2 - 1) * 2);
  });

  it.each(cells.map((cell) => [cell.name, cell] as const))('%s', (_name, { name, m, log, count, undo }) => {
    const floating = log === 'floating' || log === 'floating wide';
    const place = placeNoticeStack(m);
    const { card, rows, line } = stackGeometry(m, place);
    expect(card).not.toBeNull();
    const boxes = [{ top: card!.top, bottom: card!.bottom }, ...rows];
    // No notice overlaps another, or the card (its header and footer among it).
    const all = [...boxes].sort((a, b) => a.top - b.top);
    for (let i = 1; i < all.length; i += 1) expect(all[i].top).toBeGreaterThanOrEqual(all[i - 1].bottom);
    // Header and footer whole, at least one line between them.
    expect(card!.footTop - card!.headBottom).toBeGreaterThanOrEqual(20);
    // The give-way order: the log gives only past every fold, and collapses
    // only past its floor; the kept lines go under the fade only past both.
    const placed = placedCard(m, place)!;
    const chrome = placed.chrome;
    const floors = bodyFloors(placed);
    const give = place.squeeze + (place.collapse ? m.logCollapse! : 0);
    if (place.squeeze > 0) expect(place.mode === 'pill' || place.mode === 'under' || !rows.some((row) => row.kind === 'notice' && !undo)).toBe(true);
    if (place.collapse) expect(place.squeeze).toBe(m.logSpare);
    if (place.underFade) {
      expect(give).toBe(place.aboveLog || (floating && give > 0) ? m.logSpare! + m.logCollapse! : give);
      SHORT[name] = [place.cap! - chrome, floors.min];
      // The plan line first, whole between the fades.
      if (place.cap! - chrome >= floors.one) {
        expect(card!.first!.top).toBeGreaterThanOrEqual(card!.headBottom);
        expect(card!.first!.bottom).toBeLessThanOrEqual(card!.footTop - FADE_PX);
      } else {
        PLAN_SHORT[name] = [place.cap! - chrome, floors.one];
      }
    } else {
      expect(card!.plan!.top).toBeGreaterThanOrEqual(card!.headBottom);
      expect(card!.plan!.bottom).toBeLessThanOrEqual(card!.footTop - FADE_PX);
    }
    // GM r10: scrolled, the body stops on a line boundary: the first line
    // in view is whole, under the body's top edge (4 px under the header).
    if (card!.scroll) {
      for (const lineBox of placed.lines ?? []) {
        const top = card!.headBottom + lineBox.top - card!.scroll;
        const bottom = card!.headBottom + lineBox.bottom - card!.scroll;
        if (bottom > card!.headBottom + 0.5) expect(top).toBeGreaterThanOrEqual(card!.headBottom - 0.5);
      }
    }
    // Beside a log in the narrow layout, every part never covered fits.
    if (place.narrow) {
      expect(place.narrow).toBeGreaterThanOrEqual(NARROW_MIN);
      expect(place.narrow).toBeLessThan(BESIDE_LOG_MIN_W);
      expect(PLAN_SHORT[name]).toBeUndefined();
    }
    // A notice with an Undo is always whole; the newest whole or in the pill.
    const shownNotices = rows.filter((row) => row.kind === 'notice').length;
    if (count) expect(shownNotices).toBe(count - place.folded);
    if (undo) expect(place.fold[count - 1]).toBe(false);
    if (place.folded && place.moreHost < 0) expect(rows[0].kind).toBe('more');
    // With an Undo notice showing, the count rides in its row: no row of its own.
    if (place.folded && undo) {
      expect(place.moreHost).toBe(count - 1);
      expect(rows.some((row) => row.kind === 'more')).toBe(false);
    }
    // A floating log (GM r9, r11): beside it, with 400 px there or the
    // narrow layout, the region stopping short of it; else under it, its
    // bottom come up by its give; else above it, its top come down by it;
    // never across it.
    if (floating) SIDE[name] = place.float ?? 'none';
    if (place.narrow) NARROWED[name] = place.narrow;
    if (floating && (place.float === 'left' || place.float === 'right')) {
      const float = m.floating!;
      const inset = place.inset!;
      // 400 px there, or the card's narrow layout (GM r10).
      expect(m.viewportW - inset.right - inset.left).toBeGreaterThanOrEqual(place.narrow ? NARROW_MIN : BESIDE_LOG_MIN_W);
      if (place.float === 'left') expect(m.viewportW - inset.right).toBeLessThanOrEqual(float.left - FLOAT_GAP_PX);
      else expect(inset.left).toBeGreaterThanOrEqual(float.right + FLOAT_GAP_PX);
      expect(inset.left).toBeGreaterThanOrEqual(m.regionLeft);
      expect(place).toMatchObject({ squeeze: 0, collapse: false });
    } else if (floating) {
      expect(place.inset ?? null).toBeNull();
      const float = m.floating!;
      // The log as it shows, held at the edge away from the card (GM r11).
      const shown = place.float === 'under' ? { top: float.top, bottom: float.bottom - give } : { top: float.top + give, bottom: float.bottom };
      expect(shown.bottom - shown.top).toBeGreaterThanOrEqual(CLOSED_LOG);
      if (give) expect(place.hold).toBe(place.float === 'under' ? 'top' : 'bottom');
      // No card, notice or row ever crosses it, at either log width.
      for (const box of boxes) expect(box.bottom <= shown.top - FLOAT_GAP_PX + 0.5 || box.top >= shown.bottom + FLOAT_GAP_PX - 0.5).toBe(true);
    }
    // Nothing off screen; nothing past the top line.
    for (const box of boxes) {
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(m.viewportH);
      if (!place.over) expect(box.top).toBeGreaterThanOrEqual(place.topLine ?? m.topLine);
    }
    // The docked log: it gives at most its body and its collapse, and
    // nothing reaches its header (now at its top line plus the give).
    if (log === 'open' && place.aboveLog) {
      expect(place.squeeze).toBeLessThanOrEqual(m.logSpare!);
      const header = m.viewportH - m.logTop + 8 + give;
      expect(line).toBe(header - 8 + place.over);
      expect(place.over).toBe(0);
      for (const box of boxes) expect(box.bottom).toBeLessThanOrEqual(header - 8);
    } else if (!floating) {
      expect(place.squeeze).toBe(0);
      expect(place.collapse).toBe(false);
    }
  });

  it('GM r9-r11: how round 3f\'s 71 floating cells resolve, step by step', () => {
    // 1: beside the log; 2: under it, its body giving way; 3: above it,
    // the same; each only when the kept lines show; else 4: a named
    // shortfall (SHORT).
    const step = (name: string) => (SIDE[name] === 'left' || SIDE[name] === 'right' ? 1 : SHORT[name] ? 4 : SIDE[name] === 'under' ? 2 : 3);
    const count = (names: string[]) => [1, 2, 3, 4].map((n) => names.filter((name) => step(name) === n).length);
    const all = Object.keys(SIDE);
    expect(all).toHaveLength(252);
    expect([1, 2, 3, 4].map((n) => all.filter((name) => step(name) === n).length)).toEqual(EXPECTED_R11_ALL);
    // With the log at its own width.
    const own = R3F_FLOATING_SHORT;
    expect(count(own)).toEqual(EXPECTED_R11_OWN);
    // Step 1 takes every 1024x640 cell (595 px beside the log, on its
    // right) and, in the narrow layout (GM r10), every 768x600 one (339 px);
    // step 2 the 420 ones, the log giving way under it (GM r11).
    expect(own.filter((name) => step(name) === 1).every((name) => /^(1024x640|768x600)/.test(name))).toBe(true);
    expect(own.filter((name) => step(name) === 1 && name.startsWith('768x600')).length).toBe(EXPECTED_R10_768);
    expect(own.filter((name) => step(name) === 4)).toEqual(Object.keys(EXPECTED_SHORT).filter((name) => / floating (?!wide)/.test(name)));
    // With it resized to the column's width, as round 3f's grid had it.
    const wide = R3F_FLOATING_SHORT.map((name) => name.replace(' floating', ' floating wide'));
    expect(count(wide)).toEqual(EXPECTED_R11_WIDE);
    // The wide log's 768x600 cells, "768x600 floating wide 0" among them:
    // under it, its body given way, the kept lines whole.
    const wide768 = all.filter((name) => name.startsWith('768x600 floating wide'));
    expect(wide768).toHaveLength(18);
    expect(wide768.every((name) => step(name) === 2 && !PLAN_SHORT[name])).toBe(true);
    // No floating cell is a shortfall now, at either width.
    expect(Object.keys(SHORT).filter((name) => name.includes('floating'))).toEqual([]);
    // GM r10: the narrow layout takes every 768x600 cell beside the log,
    // docked (356 px) or floating at its own width (339 px), and the wide
    // log's 1024x640 cells (337 px); nothing else goes narrow.
    const narrowed = Object.entries(NARROWED).reduce<Record<string, number>>((acc, [name, width]) => {
      const key = `${name.split(' ').slice(0, 2).join(' ')}${name.includes(' wide') ? ' wide' : ''} ${width}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    expect(narrowed).toEqual({ '768x600 open 356': 18, '768x600 closed 356': 18, '768x600 floating 339': 18, '1024x640 floating wide 337': 18 });
  });

  it('lists the cells where every step leaves the body short of its kept lines', () => {
    // [the body it gets, the kept lines' need: 65 + two fades, and from
    // round 3h (GM r10) the 11 px to the line boundary above the top fade].
    expect(SHORT).toEqual(EXPECTED_SHORT);
    for (const [body, need] of Object.values(SHORT)) expect(body).toBeLessThan(need);
    // The plan line shows whole in every one of them but these.
    expect(PLAN_SHORT).toEqual(EXPECTED_PLAN_SHORT);
    for (const [body, need] of Object.values(PLAN_SHORT)) expect(body).toBeLessThan(need);
    // GM r7's cells: 420x560, the docked log, the banner, 2-4 notices with
    // no Undo: the plan line whole, the ⚠ line short (under the fade; 12 px
    // until round 3h, 23 px now the scroll stops on a line boundary).
    for (const count of [2, 3, 4]) {
      expect(SHORT[`420x560 open ${count} banner`]).toEqual([85, 108]);
      expect(PLAN_SHORT[`420x560 open ${count} banner`]).toBeUndefined();
    }
  });
});

describe('the jump frame', () => {
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

  it('marks the region for the frame it lands in, then lets the spring back', () => {
    vi.useFakeTimers();
    const frames: Array<() => void> = [];
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { frames.push(fn); return frames.length; });
    document.body.innerHTML = '<div data-notice-region=""><div class="notice-region__stack"></div></div>';
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    const stack = document.querySelector<HTMLElement>('.notice-region__stack')!;
    const place: StackPlace = { aboveLog: true, lift: 126, cap: null, mode: null, folded: 0, more: 0, expanded: false, keepPlan: false, squeeze: 0, underFade: false, over: 0 };
    applyNoticeStack(region, stack, place, true);
    expect(region.hasAttribute(JUMP_ATTR)).toBe(true);
    expect(region.style.getPropertyValue('--notice-stack-lift')).toBe('126px');
    frames.shift()!();
    expect(region.hasAttribute(JUMP_ATTR)).toBe(true);
    frames.shift()!();
    expect(region.hasAttribute(JUMP_ATTR)).toBe(false);
    applyNoticeStack(region, stack, { ...place, lift: 80 });
    expect(region.hasAttribute(JUMP_ATTR)).toBe(false);
    // A give-way step lands the same way, its glide doing the moving.
    applyNoticeStack(region, stack, { ...place, lift: 80 }, false, true);
    expect(region.hasAttribute(JUMP_ATTR)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('the region watches its root marks and wires the jump and the glide in', () => {
    expect(REGION).toMatch(/applyNoticeStack\(region, stack, next\.place, stackJumps\(last, next\), stepChanged\(last\?\.place \?\? null, next\.place\)\)/);
  });
});

/** A stack in the DOM: the card, `count` notices and the "more" row. */
function stackDom(count: number) {
  document.body.innerHTML = `
    <div data-notice-region=""><div class="notice-region__stack">
      <button data-notice-more=""></button>
      <div data-notice-slot="proposal"><div class="card" data-notice-shrinks="">
        <div class="head"></div><div class="scroll" data-notice-shrink-body=""><div class="body"><p class="plan" data-notice-keep=""></p></div></div><div class="foot" data-notice-shrink-foot=""></div>
      </div></div>
      ${Array.from({ length: count }, (_, i) => `<div data-notice-slot="s${i}"><div class="toast t${i}"></div></div>`).join('')}
    </div></div>`;
  return {
    region: document.querySelector<HTMLElement>('[data-notice-region]')!,
    stack: document.querySelector<HTMLElement>('.notice-region__stack')!,
    card: document.querySelector<HTMLElement>('.card')!,
    more: document.querySelector<HTMLElement>('[data-notice-more]')!,
    toasts: [...document.querySelectorAll<HTMLElement>('.toast')],
  };
}

describe('the fold, the row and the glide, written to the stack', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });
  const place = (over: Partial<StackPlace>): StackPlace => ({
    aboveLog: true, lift: 188, cap: 154, mode: 'under', folded: 0, fold: [], more: 0, moreHost: -1, expanded: false, keepPlan: false, squeeze: 0, collapse: false, underFade: false, over: 0, ...over,
  });

  it('folds the older notices, names the row and its state, and marks the step', () => {
    const { region, stack, more, toasts } = stackDom(3);
    applyNoticeStack(region, stack, place({ mode: 'folded', folded: 2, fold: [true, true, false], more: 2 }));
    expect(region.dataset.noticeMode).toBe('folded');
    expect(toasts.map((toast) => toast.hasAttribute(FOLD_ATTR))).toEqual([true, true, false]);
    // Folded, inert: the dialogs' focus order and screen readers skip them.
    expect(toasts.map((toast) => toast.hasAttribute('inert'))).toEqual([true, true, false]);
    expect(region.hasAttribute(MORE_SHOWN_ATTR)).toBe(true);
    expect(more.hidden).toBe(false);
    expect(more.textContent).toBe('2 more notices');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    applyNoticeStack(region, stack, place({ mode: 'above', more: 2, expanded: true }));
    expect(toasts.some((toast) => toast.hasAttribute(FOLD_ATTR) || toast.hasAttribute('inert'))).toBe(false);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    // Unfolded it reads "Show less", as the note's Show all / Show less (GM r6).
    expect(more.textContent).toBe(SHOW_LESS);
    expect(SHOW_LESS).toBe('Show less');
    applyNoticeStack(region, stack, place({ mode: 'folded', folded: 2, fold: [true, true, false], more: 2 }));
    expect(more.textContent).toBe('2 more notices');
    // Step 2 (GM r7): every one without an Undo in the pill, "N notices";
    // one with an Undo stays whole wherever it sits.
    applyNoticeStack(region, stack, place({ mode: 'pill', folded: 2, fold: [true, false, true], more: 2 }));
    expect(more.textContent).toBe('2 notices');
    expect(toasts.map((toast) => toast.hasAttribute(FOLD_ATTR))).toEqual([true, false, true]);
    expect(toasts.map((toast) => toast.hasAttribute('inert'))).toEqual([true, false, true]);
    applyNoticeStack(region, stack, place({ mode: 'pill', folded: 1, fold: [false, false, true], more: 1 }));
    expect(more.textContent).toBe('1 notice');
    applyNoticeStack(region, stack, place({ mode: 'under' }));
    expect(region.hasAttribute(MORE_SHOWN_ATTR)).toBe(false);
    expect(more.hidden).toBe(true);
    expect(region.dataset.noticeMode).toBe('under');
    // An inert of the notice's own is not the fold's to take away.
    toasts[2].setAttribute('inert', '');
    applyNoticeStack(region, stack, place({ mode: 'under' }));
    expect(toasts[2].hasAttribute('inert')).toBe(true);
  });

  it('a hosting Undo notice carries the count: the region\'s own row hides, the store names the host (GM r8)', () => {
    const { region, stack, more, toasts } = stackDom(3);
    applyNoticeStack(region, stack, place({ mode: 'pill', folded: 2, fold: [true, true, false], more: 2, moreHost: 2 }));
    expect(toasts.map((toast) => toast.hasAttribute(MORE_HOST_ATTR))).toEqual([false, false, true]);
    expect(region.hasAttribute(MORE_SHOWN_ATTR)).toBe(false);
    expect(more.hidden).toBe(true);
    expect(more.textContent).toBe('');
    expect(getNoticeMore()).toEqual({ host: toasts[2], count: 2, expanded: false });
    applyNoticeStack(region, stack, place({ mode: 'above', fold: [false, false, false], more: 2, moreHost: 2, expanded: true }));
    expect(getNoticeMore()).toEqual({ host: toasts[2], count: 2, expanded: true });
    expect(more.hidden).toBe(true);
    // No host: the row stands on its own again, the mark gone.
    applyNoticeStack(region, stack, place({ mode: 'pill', folded: 2, fold: [true, true, false], more: 2 }));
    expect(toasts.some((toast) => toast.hasAttribute(MORE_HOST_ATTR))).toBe(false);
    expect(more.hidden).toBe(false);
    expect(more.textContent).toBe('2 notices');
    expect(getNoticeMore().host).toBe(null);
    // A host index with nothing folded writes nothing.
    applyNoticeStack(region, stack, place({ mode: 'under', moreHost: 2 }));
    expect(toasts.some((toast) => toast.hasAttribute(MORE_HOST_ATTR))).toBe(false);
    expect(getNoticeMore().host).toBe(null);
  });

  it('beside a floating log, the region stops short of it; with none it takes its own sides again (GM r9)', () => {
    const { region, stack } = stackDom(1);
    applyNoticeStack(region, stack, place({ float: 'right', inset: { left: 413, right: 16 } }));
    expect([region.style.left, region.style.right]).toEqual(['413px', '16px']);
    applyNoticeStack(region, stack, place({ float: 'left', inset: { left: 64, right: 432 } }));
    expect([region.style.left, region.style.right]).toEqual(['64px', '432px']);
    applyNoticeStack(region, stack, place({ float: 'under', inset: null }));
    expect([region.style.left, region.style.right]).toEqual(['', '']);
  });

  it('a move beside the log or back glides sideways on the spring, no jump (GM r9)', () => {
    const { region, stack, card } = stackDom(0);
    let left = 212;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this === card ? { top: 300, bottom: 450, height: 150, left, width: 600 } : { top: 0, bottom: 0, height: 0, left: 0, width: 0 }) as DOMRect;
    });
    const moves: Keyframe[][] = [];
    Object.defineProperty(HTMLElement.prototype, 'animate', { value: vi.fn((frames: Keyframe[]) => { moves.push(frames); return { cancel() {} } as Animation; }), configurable: true });
    const under = place({ float: 'under', inset: null });
    applyNoticeStack(region, stack, under);
    left = 413;
    const beside = place({ float: 'right', inset: { left: 413, right: 16 } });
    expect(stepChanged(under, beside)).toBe(true);
    applyNoticeStack(region, stack, beside, false, stepChanged(under, beside));
    expect(moves).toEqual([[{ transform: 'translate(-201px, 0px)' }, { transform: 'translate(0, 0)' }]]);
    // Dragging the log moves the inset: that glides too.
    expect(stepChanged(beside, { ...beside, inset: { left: 420, right: 16 } })).toBe(true);
    expect(stepChanged(beside, { ...beside })).toBe(false);
    expect(stepChanged(under, place({ float: 'above', inset: null }))).toBe(true);
  });

  it('scrolls the plan line into view when the body is shorter than note and plan', () => {
    const { region, stack } = stackDom(1);
    const scroller = document.querySelector<HTMLElement>('.body')!;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('plan')) return { top: 180 - this.parentElement!.scrollTop, bottom: 213 - this.parentElement!.scrollTop, height: 33 } as DOMRect;
      if (this.classList.contains('body')) return { top: 100, bottom: 165, height: 65 } as DOMRect;
      return { top: 0, bottom: 0, height: 0 } as DOMRect;
    });
    applyNoticeStack(region, stack, place({ keepPlan: true }));
    // 213 - (165 - 16): the plan line's foot clears the fade.
    expect(scroller.scrollTop).toBe(64);
    scroller.scrollTop = 0;
    applyNoticeStack(region, stack, place({ keepPlan: false }));
    expect(scroller.scrollTop).toBe(0);
  });

  it('with a ⚠ row, scrolls until the row\'s foot clears the fade: whole lines, never a cut (GM r6)', () => {
    const { region, stack } = stackDom(1);
    const scroller = document.querySelector<HTMLElement>('.body')!;
    const warn = document.createElement('li');
    warn.className = 'warn';
    warn.setAttribute('data-notice-keep', '');
    scroller.appendChild(warn);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('plan')) return { top: 180 - scroller.scrollTop, bottom: 213 - scroller.scrollTop, height: 33 } as DOMRect;
      if (this.classList.contains('warn')) return { top: 219 - scroller.scrollTop, bottom: 245 - scroller.scrollTop, height: 26 } as DOMRect;
      if (this.classList.contains('body')) return { top: 100, bottom: 197, height: 97 } as DOMRect;
      return { top: 0, bottom: 0, height: 0 } as DOMRect;
    });
    applyNoticeStack(region, stack, place({ keepPlan: true }));
    // 245 - (197 - 16): the ⚠ row whole over the bottom fade, the plan line over it.
    expect(scroller.scrollTop).toBe(64);
    expect(180 - 64).toBeGreaterThanOrEqual(100 + FADE_PX);
  });

  it('under its kept lines (step 5), the plan line first, just under the top fade, the ⚠ row next (GM r7)', () => {
    const { region, stack } = stackDom(1);
    const scroller = document.querySelector<HTMLElement>('.body')!;
    const warn = document.createElement('li');
    warn.className = 'warn';
    warn.setAttribute('data-notice-keep', '');
    scroller.appendChild(warn);
    let view = { top: 100, bottom: 170, height: 70 };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('plan')) return { top: 180 - scroller.scrollTop, bottom: 213 - scroller.scrollTop, height: 33 } as DOMRect;
      if (this.classList.contains('warn')) return { top: 219 - scroller.scrollTop, bottom: 245 - scroller.scrollTop, height: 26 } as DOMRect;
      if (this.classList.contains('body')) return view as DOMRect;
      return { top: 0, bottom: 0, height: 0 } as DOMRect;
    });
    applyNoticeStack(region, stack, place({ keepPlan: true, underFade: true }));
    // 180 - (100 + 16): the plan line's top just under the top fade, its foot over the bottom one.
    expect(scroller.scrollTop).toBe(64);
    expect(213 - 64).toBeLessThanOrEqual(170 - FADE_PX);
    // Scrolled past it already: it comes back.
    scroller.scrollTop = 120;
    applyNoticeStack(region, stack, place({ keepPlan: true, underFade: true }));
    expect(scroller.scrollTop).toBe(64);
    // Too short for both fades: centred.
    view = { top: 100, bottom: 141, height: 41 };
    scroller.scrollTop = 0;
    applyNoticeStack(region, stack, place({ keepPlan: true, underFade: true }));
    expect(scroller.scrollTop).toBe(180 - 104);
  });

  it('reads which notices offer Undo or Redo: they never fold', () => {
    document.body.innerHTML = `
      <div class="a"><span>Saved.</span><button>×</button></div>
      <div class="b"><span>Deleted 2 nodes.</span><button>Undo</button></div>
      <div class="c"><button> Redo </button></div>
      <div class="d" data-notice-undo=""></div>
      <div class="e"><button>Undone</button></div>`;
    const at = (name: string) => offersUndo(document.querySelector<HTMLElement>(`.${name}`)!);
    expect(['a', 'b', 'c', 'd', 'e'].map(at)).toEqual([false, true, true, true, false]);
  });

  it('glides each from where it rested to its new place on the spring, the card by its footer; reduced motion lands at once', () => {
    const { region, stack, card, toasts } = stackDom(2);
    const tops = new Map<HTMLElement, number>([[card, 200], [toasts[0], 400], [toasts[1], 460]]);
    const heights = new Map<HTMLElement, number>([[card, 150]]);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = tops.get(this);
      const height = heights.get(this) ?? 46;
      return (top === undefined ? { top: 0, bottom: 0, height: 0 } : { top, bottom: top + height, height }) as DOMRect;
    });
    const moves: Array<[string, Keyframe[]]> = [];
    const animate = vi.fn(function (this: HTMLElement, frames: Keyframe[]) { moves.push([this.className, frames]); return { cancel() {} } as Animation; });
    Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true });
    applyNoticeStack(region, stack, place({ mode: 'under' }));
    expect(animate).not.toHaveBeenCalled();
    // Step 2: the notices above, the card on the line.
    // Step 2: the notices above, the card on the line, 30 px shorter (held by its footer).
    tops.set(card, 330); heights.set(card, 120); tops.set(toasts[0], 222); tops.set(toasts[1], 276);
    applyNoticeStack(region, stack, place({ mode: 'above' }), false, true);
    expect(moves).toEqual([
      ['card', [{ transform: 'translate(0px, -100px)' }, { transform: 'translate(0, 0)' }]],
      ['toast t0', [{ transform: 'translate(0px, 178px)' }, { transform: 'translate(0, 0)' }]],
      ['toast t1', [{ transform: 'translate(0px, 184px)' }, { transform: 'translate(0, 0)' }]],
    ]);
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: GLIDE_MS });
    // Reduced motion: the same step on a fresh stack, no glide.
    const fresh = stackDom(2);
    const freshTops = new Map<HTMLElement, number>([[fresh.card, 200], [fresh.toasts[0], 400], [fresh.toasts[1], 460]]);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      const top = freshTops.get(this);
      return (top === undefined ? { top: 0, bottom: 0, height: 0 } : { top, bottom: top + 46, height: 46 }) as DOMRect;
    });
    applyNoticeStack(fresh.region, fresh.stack, place({ mode: 'under' }));
    freshTops.set(fresh.card, 300); freshTops.set(fresh.toasts[0], 192); freshTops.set(fresh.toasts[1], 246);
    animate.mockClear();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
    applyNoticeStack(fresh.region, fresh.stack, place({ mode: 'above' }), false, true);
    expect(animate).not.toHaveBeenCalled();
    // With motion, the way back glides.
    vi.unstubAllGlobals();
    freshTops.set(fresh.card, 200); freshTops.set(fresh.toasts[0], 400); freshTops.set(fresh.toasts[1], 460);
    applyNoticeStack(fresh.region, fresh.stack, place({ mode: 'under' }), false, true);
    expect(animate).toHaveBeenCalled();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  it('rests by its layout box, without the translate or the entrance scale it draws with', () => {
    const { card } = stackDom(0);
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ top: 104, bottom: 248, height: 144, left: 40, width: 576 } as DOMRect);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ transform: 'matrix(0.96, 0, 0, 0.96, 12, -30)' } as CSSStyleDeclaration);
    // 150 tall (600 wide) at 0.96 about its centre, 30 px up and 12 right
    // (a sideways glide, GM r9): it rests at 131-281, from 16.
    const rest = layoutBox(card);
    expect(rest).toMatchObject({ top: 131, bottom: 281, height: 150 });
    expect(rest.left).toBeCloseTo(16, 6);
    expect(rest.width).toBeCloseTo(600, 6);
    vi.mocked(window.getComputedStyle).mockReturnValue({ transform: 'none' } as CSSStyleDeclaration);
    expect(layoutBox(card)).toEqual({ top: 104, bottom: 248, height: 144, left: 40, width: 576 });
  });

  it('a folded notice never glides, and a glide skips what has no place to come from', () => {
    const { card, toasts } = stackDom(2);
    const animate = vi.fn(() => ({ cancel() {} }) as Animation);
    Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 10, bottom: 56, height: 46 } as DOMRect);
    toasts[0].setAttribute(FOLD_ATTR, '');
    const from = { top: 100, bottom: 146, height: 46 };
    expect(glideStack([
      { element: toasts[0], from }, { element: toasts[1], from: undefined }, { element: card, from: { top: 10.4, bottom: 56.4, height: 46 } },
      { element: toasts[1], from },
    ], 'ease')).toBe(1);
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });
});

describe('the offline banner joins the card\'s top line (GM r4 7)', () => {
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

  it('noticeTopLimit is below the banner while it shows, and the floating panels\' line is not', () => {
    document.body.innerHTML = `<div ${NOTICE_TOP_LINE_ATTR}="" class="banner"></div>`;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.classList.contains('banner') ? { top: 150, bottom: 198, height: 48 } : { top: 0, bottom: 0, height: 0 }) as DOMRect;
    });
    expect(noticeTopLimit(16)).toBe(198 + 16);
    document.body.innerHTML = '';
    expect(noticeTopLimit(16)).toBe(16);
    const banner = readFileSync(join(__dirname, '../src/components/BackendConnectionStatus.tsx'), 'utf8');
    expect(banner).toMatch(/\[NOTICE_TOP_LINE_ATTR\]: ''/);
    expect(banner).toMatch(/setAttribute\(BANNER_SHOWN_ATTR, ''\)/);
    expect(REGION).toMatch(/attributeFilter: \['style', BANNER_SHOWN_ATTR\]/);
    expect(REGION).toMatch(/noticeTopLimit\(TOP_GUTTER\)/);
  });
});

describe('measured from the live stack', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.style.removeProperty('--agent-log-clearance');
    document.documentElement.style.removeProperty('--agent-log-top');
    document.documentElement.style.removeProperty('--agent-log-natural-h');
    document.documentElement.style.removeProperty('--agent-log-floor');
    document.documentElement.style.removeProperty(LOG_SQUEEZE_VAR);
    document.body.innerHTML = '';
  });

  it('reads the notices, the card\'s fixed rows, its plan line and the log, and writes the mode, lift and cap', () => {
    document.documentElement.style.setProperty('--agent-log-clearance', '348px');
    document.documentElement.style.setProperty('--agent-log-top', '206px');
    document.documentElement.style.setProperty('--agent-log-natural-h', '198px');
    document.documentElement.style.setProperty('--agent-log-floor', '91px');
    document.documentElement.style.setProperty('--agent-log-collapse', '47px');
    document.body.innerHTML = `
      <div data-notice-region=""><div class="notice-region__stack">
        <div data-notice-slot="proposal"><div class="card" data-notice-shrinks="">
          <div class="head"></div><div class="scroll" data-notice-shrink-body=""><div class="body"><p class="plan" data-notice-keep=""></p><ul><li class="warn" data-notice-keep=""></li></ul></div></div>
          <div class="foot" data-notice-shrink-foot=""></div>
        </div></div>
        <div data-notice-slot="late"><div class="toast"><button>×</button></div></div>
        <div data-notice-slot="canvas"><div class="toast"><button>Undo</button><span ${MORE_SLOT_ATTR}="" hidden></span></div></div>
      </div></div>`;
    // The card mid-entrance, at 0.96 of its layout size: what it reads is in
    // layout pixels all the same.
    const k = 0.96;
    const boxes: Record<string, Partial<DOMRect>> = {
      '[data-notice-region]': { left: 70, bottom: 820 },
      '.card': { top: 766 - 366 * k, bottom: 766, height: 366 * k },
      '.body': { top: 434 },
      '.plan': { top: 434 + 77 * k, bottom: 434 + 110 * k },
      '.warn': { top: 434 + 116 * k, bottom: 434 + 142 * k },
      '.foot': { top: 766 - 54 * k },
    };
    const heights: Record<string, number> = { '.card': 366, '.scroll': 266, '.toast': 46 };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const hit = Object.entries(boxes).find(([selector]) => this.matches(selector));
      return { top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0, ...(hit?.[1] ?? {}) } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return Object.entries(heights).find(([selector]) => this.matches(selector))?.[1] ?? 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('body') ? 700 : 0;
    });
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    const stack = document.querySelector<HTMLElement>('.notice-region__stack')!;
    Object.defineProperty(window, 'innerWidth', { value: 420, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    const m = measureNoticeStack(region, stack, 72);
    expect(m).toMatchObject({ regionLeft: 70, regionBottom: 80, logClearance: 348, logTop: 206, topLine: 72, logSpare: 198 - 91, logCollapse: 47 });
    // The kept lines: the plan line's top to the first ⚠ row's foot; the
    // plan line alone; which notices offer Undo (GM r7: they never fold).
    expect(m.card).toMatchObject({
      chrome: 100, body: 700, foot: 54, items: [46, 46], plan: { top: 77, bottom: 142 }, first: { top: 77, bottom: 110 }, undo: [false, true], host: [false, true],
    });
    applyNoticeStack(region, stack, placeNoticeStack(m));
    expect(region.dataset.aboveLog).toBe('true');
    expect(region.dataset.noticeMode).toBe('under');
    expect(region.style.getPropertyValue('--notice-stack-lift')).toBe('126px');
    expect(document.querySelector<HTMLElement>('.card')!.style.getPropertyValue('--notice-card-cap'))
      .toBe(`${900 - 80 - 126 - 2 * 54 - 72}px`);
    document.documentElement.style.removeProperty('--agent-log-collapse');
  });

  it('with no card, reads the notices shown and their column, and the floating log (GM r8 4)', () => {
    for (const [name, value] of Object.entries({ top: 300, bottom: 520, left: 65, right: 403 })) {
      document.documentElement.style.setProperty(`--agent-log-float-${name}`, `${value}px`);
    }
    document.body.innerHTML = `
      <div data-notice-region=""><div class="notice-region__stack">
        <div data-notice-slot="a"><div class="toast a" ${FOLD_ATTR}=""></div></div>
        <div data-notice-slot="b"><div class="toast b"></div></div>
        <div data-notice-slot="c"><div class="toast c"></div></div>
        <div data-notice-slot="d"><div class="toast d"></div></div>
      </div></div>`;
    const boxes: Record<string, Partial<DOMRect>> = {
      '[data-notice-region]': { left: 64, bottom: 559 },
      '.b': { left: 70, right: 380 }, '.c': { left: 64, right: 404 },
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const hit = Object.entries(boxes).find(([selector]) => this.matches(selector));
      return { top: 0, bottom: 0, left: 0, right: 0, height: 0, width: 0, ...(hit?.[1] ?? {}) } as DOMRect;
    });
    // The folded one and an empty one take no room.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.matches('.b, .c, .a') ? 46 : 0;
    });
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    const stack = document.querySelector<HTMLElement>('.notice-region__stack')!;
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 640, configurable: true });
    const m = measureNoticeStack(region, stack, 116);
    expect(m).toMatchObject({ card: null, notices: { items: [46, 46], gap: 8 }, column: { left: 64, right: 404 }, floating: { top: 300, bottom: 520, left: 65, right: 403 } });
    for (const name of ['top', 'bottom', 'left', 'right']) document.documentElement.style.removeProperty(`--agent-log-float-${name}`);
    // No notices: nothing to clear.
    document.body.innerHTML = '<div data-notice-region=""><div class="notice-region__stack"></div></div>';
    expect(measureNoticeStack(document.querySelector<HTMLElement>('[data-notice-region]')!, document.querySelector<HTMLElement>('.notice-region__stack')!, 116))
      .toMatchObject({ notices: null, column: null, floating: null });
  });

  it('reads the region and the card\'s column as they are with no inset beside a floating log, and puts the inset back (GM r9)', () => {
    document.body.innerHTML = `
      <div data-notice-region="" style="left: 413px; right: 16px"><div class="notice-region__stack">
        <div data-notice-slot="proposal"><div class="card" data-notice-shrinks="">
          <div class="head"></div><div class="scroll" data-notice-shrink-body=""><div class="body"></div></div>
        </div></div>
      </div></div>`;
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    const stack = document.querySelector<HTMLElement>('.notice-region__stack')!;
    const card = document.querySelector<HTMLElement>('.card')!;
    const inset = () => region.style.left !== '';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === region) return (inset() ? { left: 413, right: 1008, width: 595, bottom: 560 } : { left: 64, right: 1008, width: 944, bottom: 560 }) as DOMRect;
      if (this === card) return (inset() ? { left: 413, right: 1008, width: 595, top: 300, bottom: 450, height: 150 } : { left: 236, right: 836, width: 600, top: 300, bottom: 450, height: 150 }) as DOMRect;
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this === card ? (inset() ? 595 : 600) : 0;
    });
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 640, configurable: true });
    const m = measureNoticeStack(region, stack, 70);
    expect(m.regionLeft).toBe(64);
    expect(m.column).toEqual({ left: 236, right: 836 });
    expect([region.style.left, region.style.right]).toEqual(['413px', '16px']);
  });

  it('the empty toolbar Panel keeps its room in the top line, so a selection never moves the card (GM r6: not (c))', () => {
    expect(REGION).toMatch(/measureNoticeStack\(region, stack, noticeTopLimit\(TOP_GUTTER\)\)/);
    document.body.innerHTML = `<div ${TOP_BAR_ATTR}="" class="tabs"></div><div ${TOP_BAR_ATTR}="" class="panel"></div>`;
    const panel = { width: 0 };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('tabs')) return new DOMRect(48, 12, 324, 40);
      return new DOMRect(210, 58, panel.width, 50);
    });
    expect(noticeTopLimit(16)).toBe(108 + 8);
    panel.width = 540;
    expect(noticeTopLimit(16)).toBe(108 + 8);
  });

  it('gives the log\'s squeeze to the root, and takes it back when there is none', () => {
    const { region, stack } = stackDom(0);
    const root = document.documentElement;
    const place: StackPlace = { aboveLog: true, lift: 100, cap: 186, mode: 'under', folded: 0, more: 0, expanded: false, keepPlan: false, squeeze: 64, underFade: false, over: 0 };
    applyNoticeStack(region, stack, place);
    expect(root.style.getPropertyValue(LOG_SQUEEZE_VAR)).toBe('64px');
    applyNoticeStack(region, stack, { ...place, squeeze: 0 });
    expect(root.style.getPropertyValue(LOG_SQUEEZE_VAR)).toBe('');
  });

  it('re-measures when the stack, the top bars or the root variables change (review 1 HIGH-1, LOW-5)', () => {
    expect(REGION).toMatch(/watch\(stack\)/);
    expect(REGION).toMatch(/querySelectorAll\(`\[\$\{TOP_BAR_ATTR\}\]`\)\.forEach\(watch\)/);
    expect(REGION).toMatch(/observe\(document\.documentElement, \{ attributes: true, attributeFilter: \['style', BANNER_SHOWN_ATTR\] \}\)/);
  });
});

describe('GM r10 (round 3h)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty('--agent-log-clearance');
    document.body.innerHTML = '';
  });
  const L = (...pairs: Array<[number, number]>): BodyLine[] => pairs.map(([top, bottom]) => ({ top, bottom }));
  const LINES = L([0, 16], [20, 36], [40, 56], [60, 76], [80, 96]);
  const straddles = (lines: BodyLine[], scroll: number) => lines.some((line) => line.top < scroll - 0.5 && line.bottom > scroll + 0.5);

  it('the give-way scroll stops on a line boundary, keeping the kept lines whole and clear of the fades', () => {
    // From the bottom: 76 + 16 - 60 = 32 cuts 20-36; down to 20 the line at
    // 60-76 sits in the bottom fade, up to 36 it is whole and clear.
    expect(bodyScrollTop({ view: 60, content: 100, kept: L([60, 76]), underFade: false, from: 0 })).toBe(32);
    expect(bodyScrollTop({ view: 60, content: 100, kept: L([60, 76]), lines: LINES, underFade: false, from: 0 })).toBe(36);
    // Up would cut the kept lines' top (30), so down to the line's top: 20.
    expect(bodyScrollTop({ view: 60, content: 100, kept: L([30, 66]), lines: LINES, underFade: false, from: 0 })).toBe(20);
    // Up would cut the kept top even though it is nearer: down, whole.
    expect(bodyScrollTop({ view: 60, content: 100, kept: L([24, 66]), lines: L([15, 28]), underFade: false, from: 0 })).toBe(15);
    // Neither is clear: the nearer whole one (here down, 2 px off).
    expect(bodyScrollTop({ view: 40, content: 200, kept: L([56, 70]), lines: L([44, 55]), underFade: false, from: 0 })).toBe(44);
    expect(bodyScrollTop({ view: 50, content: 100, kept: L([60, 76]), lines: LINES, underFade: false, from: 0 })).toBe(40);
    // A boundary that lands inside the next line isn't one.
    expect(bodyScrollTop({ view: 60, content: 200, kept: L([80, 96]), lines: L([40, 56.5], [56.2, 70], [80, 96]), underFade: false, from: 0 })).toBe(40);
    // Under the fade: the plan line alone, centred (12 px over it), then
    // stopped on the boundary under 48.
    const fade = bodyScrollTop({ view: 40, content: 100, kept: L([60, 76], [60, 120]), lines: LINES, underFade: true, from: 0 });
    expect(fade).toBe(56);
    expect(straddles(LINES, fade)).toBe(false);
    // Held to the body's scroll range; with no height read, not above.
    expect(bodyScrollTop({ view: 60, content: 50, kept: L([60, 76]), lines: LINES, underFade: false, from: 0 })).toBe(0);
    expect(bodyScrollTop({ view: 60, content: 0, kept: L([160, 176]), underFade: false, from: 0 })).toBe(132);
    expect(bodyScrollTop({ view: 60, content: 100, kept: [], underFade: false, from: 7 })).toBe(7);
  });

  it('the floors count the room to the line boundary above the top fade', () => {
    expect(lineStop(-4, LINES)).toBe(0);
    expect(lineStop(30, LINES)).toBe(20);
    expect(lineStop(38, LINES)).toBe(38);
    expect(lineStop(30)).toBe(30);
    // The live card: the plan line at 77 has its top fade at 61, in the
    // line 50-66.5 above it, so its floors grow by the 11 px to 50.
    expect(bodyFloors(LIVE_CARD)).toMatchObject({ min: 97, one: 65 });
    expect(bodyFloors({ ...LIVE_CARD, lines: LIVE_LINES })).toMatchObject({ min: 108, one: 76 });
  });

  it('the line boxes skip what an ancestor clips, not what the body itself scrolls away', () => {
    document.body.innerHTML = `<div class="scroller" style="overflow-y: auto"><p class="note" style="overflow: hidden"><span>clamped</span></p><p>plan</p></div>`;
    const root = document.querySelector<HTMLElement>('.scroller')!;
    const note = document.querySelector<HTMLElement>('.note')!;
    vi.spyOn(note, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 140 } as DOMRect);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 150 } as DOMRect);
    const rects: Record<string, Array<Partial<DOMRect>>> = {
      // Two lines in the clamp's box, a third clipped below it, and two
      // pieces of one line merged.
      clamped: [{ top: 100, bottom: 116, width: 50, height: 16 }, { top: 120, bottom: 136, width: 30, height: 16 }, { top: 121, bottom: 137, width: 20, height: 16 }, { top: 140, bottom: 156, width: 40, height: 16 }],
      // Below the scroller's own box: still a line (it scrolls into view).
      plan: [{ top: 170, bottom: 186, width: 40, height: 16 }, { top: 190, bottom: 190, width: 0, height: 0 }],
    };
    let node: Node | null = null;
    vi.spyOn(document, 'createRange').mockImplementation(() => ({
      selectNodeContents(target: Node) { node = target; },
      getClientRects() { return rects[node!.textContent!] as DOMRect[]; },
    }) as unknown as Range);
    expect(textLines(root)).toEqual(L([100, 116], [120, 137], [170, 186]));
  });

  it('a glide stays inside the window on every frame, its spring\'s overshoot too', () => {
    const SPRING = /--notice-spring:\s*(linear\([^)]*\))/.exec(REGION_CSS)![1];
    const peak = easingPeak(SPRING);
    expect(peak).toBeCloseTo(1.022, 6);
    expect(easingPeak('ease')).toBe(1);
    expect(easingPeak('linear(0, 0.5, 1)')).toBe(1);
    // Held in [lo, hi], and short enough that its overshoot is too.
    expect(inWindow(224, -200, 24, 1)).toBe(24);
    expect(inWindow(-300, -200, 24, 1)).toBe(-200);
    expect(inWindow(224, -2, 222, 1.022)).toBeCloseTo(2 / 0.022, 6);
    expect(inWindow(-222, -222, 2, 1.022)).toBeCloseTo(-2 / 0.022, 6);
    // Already outside: it never pushes further out.
    expect(inWindow(50, 10, 30, 1)).toBe(30);
    expect(inWindow(-50, -30, -10, 1)).toBe(-30);
    expect(inWindow(-50, 10, 30, 1)).toBe(0);
    expect(inWindow(50, -30, -10, 1)).toBe(0);
    // A 1024 -> 800 resize: the card rested at 424-1000, now at 200-776 in
    // an 800 px window; and two near the edges, where the overshoot binds.
    const stops = SPRING.slice(7, -1).split(',').map((stop) => Number.parseFloat(stop));
    vi.stubGlobal('innerWidth', 800);
    vi.stubGlobal('innerHeight', 900);
    const cases = [
      { from: { top: 500, bottom: 700, height: 200, left: 424, width: 576 }, to: { left: 200, width: 576 } },
      { from: { top: 500, bottom: 700, height: 200, left: 300, width: 576 }, to: { left: 2, width: 576 } },
      { from: { top: 500, bottom: 700, height: 200, left: 0, width: 576 }, to: { left: 222, width: 576 } },
      { from: { top: 860, bottom: 1060, height: 200, left: 100, width: 576 }, to: { left: 100, width: 576 } },
    ];
    const keyframes: Array<Array<{ transform: string }>> = [];
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      value: vi.fn((frames: Array<{ transform: string }>) => { keyframes.push(frames); return { cancel() {} } as Animation; }),
      configurable: true,
    });
    for (const { from, to } of cases) {
      const { card } = stackDom(0);
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ top: 500, bottom: 700, height: 200, ...to } as DOMRect);
      keyframes.length = 0;
      expect(glideStack([{ element: card, from }], SPRING)).toBe(1);
      const [dx, dy] = /translate\((-?\d+)px, (-?\d+)px\)/.exec(keyframes[0][0].transform)!.slice(1).map(Number);
      for (const e of stops) {
        const x = to.left + dx * (1 - e);
        const y = 500 + dy * (1 - e);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x + to.width).toBeLessThanOrEqual(800);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y + 200).toBeLessThanOrEqual(900);
      }
    }
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  });

  it('beside a log: 400 px as it is; from its narrow minimum, its narrow layout if every kept part fits the height', () => {
    const probe = narrowAt(339);
    const m = (over: Partial<StackMeasure> = {}): StackMeasure => ({
      ...LIVE, viewportW: 768, viewportH: 600, logClearance: 348, logTop: 268,
      card: { ...LIVE_CARD, lines: LIVE_LINES, narrowMin: NARROW_MIN, probes: [probe] }, ...over,
    });
    expect(besideCard({ ...m(), card: null }, 500, 0)).toBeNull();
    expect(besideCard(m(), 400, 0)).toMatchObject({ chrome: 89, body: 198 });
    expect(besideCard(m(), 339.7, 0)).toMatchObject({ chrome: 93, body: 194, narrowMin: NARROW_MIN });
    // Under the minimum, without one measured, or no card read at that width.
    expect(besideCard(m(), NARROW_MIN - 1, 0)).toBeNull();
    expect(besideCard(m({ card: { ...m().card!, probes: [{ ...narrowAt(NARROW_MIN), width: NARROW_MIN - 1 }] } }), NARROW_MIN - 0.5, 0)).toBeNull();
    expect(besideCard(m({ card: { ...LIVE_CARD, probes: [probe] } }), 339, 0)).toBeNull();
    expect(besideCard(m(), 338, 0)).toBeNull();
    // The window's height: header, footer, the plan line whole between its
    // fades and the notices folded, exactly; a pixel less and step 2 places it.
    const need = probe.chrome + bodyFloors({ ...LIVE_CARD, ...probe }).one + 46;
    const fit = { viewportH: need + LIVE.regionBottom + LIVE.topLine };
    expect(besideCard(m(fit), 339, 46)).not.toBeNull();
    expect(besideCard(m({ viewportH: fit.viewportH - 1 }), 339, 46)).toBeNull();
    // Placed beside the docked log at 356 px: the narrow card, the region
    // beside the log, and the card the place was made for.
    const docked = { ...m(), card: { ...m().card!, probes: [narrowAt(356)] } };
    const place = placeNoticeStack(docked);
    expect(place).toMatchObject({ narrow: 356, aboveLog: false });
    expect(placedCard(docked, place)).toMatchObject({ chrome: 93, body: 194 });
    expect(placedCard(docked, { ...place, narrow: 300 })).toBe(docked.card);
    expect(placedCard(docked, { ...place, narrow: null })).toBe(docked.card);
    // The place is made for the narrow card: a taller one keeps its plan
    // line by scrolling where the normal one would fit whole.
    const tall = (width: number): CardProbe => ({ ...narrowAt(width), body: 400, plan: { top: 300, bottom: 360 }, first: { top: 300, bottom: 330 }, lines: undefined });
    expect(place.keepPlan).toBe(false);
    expect(placeNoticeStack({ ...docked, card: { ...docked.card, probes: [tall(356)] } })).toMatchObject({ narrow: 356, keepPlan: true });
    // Beside a floating log on the column's right: the left side, narrow, the same.
    const floatingRight: StackMeasure = {
      ...m(), viewportW: 800, logClearance: 0, logTop: 0, floating: { top: 180, bottom: 360, left: 420, right: 760 },
      column: { left: 64, right: 664 }, card: { ...m().card!, probes: [tall(348)] },
    };
    expect(placeNoticeStack(floatingRight)).toMatchObject({ float: 'left', narrow: 348, keepPlan: true });
    expect(placeNoticeStack({ ...floatingRight, card: { ...floatingRight.card!, probes: [narrowAt(348)] } })).toMatchObject({ float: 'left', narrow: 348, keepPlan: false });
    // Too short for it: above the log, as before.
    expect(placeNoticeStack({ ...docked, viewportH: 300 })).toMatchObject({ narrow: null, aboveLog: true });
    // Going narrow, or back, is a step change: it glides.
    expect(stepChanged(place, { ...place, narrow: null })).toBe(true);
    expect(stepChanged(place, { ...place })).toBe(false);
  });

  it('written to the card, the body\'s scroll stops on a line boundary', () => {
    const { region, stack, card } = stackDom(0);
    card.querySelector('.plan')!.textContent = 'The plan line';
    const scroller = card.querySelector<HTMLElement>('.body')!;
    let top = 0;
    Object.defineProperty(scroller, 'scrollTop', { get: () => top, set: (value: number) => { top = value; }, configurable: true });
    Object.defineProperty(scroller, 'scrollHeight', { get: () => 100, configurable: true });
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 60, height: 60 } as DOMRect);
    vi.spyOn(card.querySelector<HTMLElement>('.plan')!, 'getBoundingClientRect').mockReturnValue({ top: 60, bottom: 76, height: 16 } as DOMRect);
    vi.spyOn(document, 'createRange').mockImplementation(() => ({
      selectNodeContents() {},
      getClientRects() { return LINES.map((line) => ({ ...line, width: 40, height: line.bottom - line.top })) as unknown as DOMRect[]; },
    }) as unknown as Range);
    const place: StackPlace = {
      aboveLog: false, lift: 0, cap: 300, mode: 'under', folded: 0, fold: [], more: 0, moreHost: -1, expanded: false,
      keepPlan: true, squeeze: 0, collapse: false, underFade: false, over: 0,
    };
    applyNoticeStack(region, stack, place);
    // 76 + 16 - 60 = 32 cuts the line at 20-36: up to its foot.
    expect(top).toBe(36);
  });

  it('a move between placements never drops a notice: each shows, or folds into the row or the pill', () => {
    // The live shots 12-15: a floating log at its own width at the card's
    // column's left, two notices, the window resized under it.
    const make = (w: number, h: number, undo: boolean): StackMeasure => {
      const column = { left: 64, right: 64 + Math.min(600, w - 80) };
      const m: StackMeasure = {
        viewportW: w, viewportH: h, gutter: 16, regionLeft: 64, regionBottom: 81, logClearance: 0, logTop: 0,
        logSpare: 180 - 91, logCollapse: 91 - CLOSED_LOG, topLine: 150,
        card: { ...LIVE_CARD, lines: LIVE_LINES, items: [46, 46], undo: [false, undo], host: [false, undo] },
        floating: { top: Math.round(h * 0.3), bottom: Math.round(h * 0.3) + 180, left: 65, right: 405 }, column,
      };
      const rooms = [besideRoom(m, 64, w - 65 + FLOAT_GAP_PX), besideRoom(m, 413, 0)].filter((room) => room >= NARROW_MIN && room < BESIDE_LOG_MIN_W);
      m.card = { ...m.card!, narrowMin: NARROW_MIN, probes: rooms.map((room) => narrowAt(Math.floor(room))) };
      return m;
    };
    const sides = new Set<string>();
    for (const undo of [false, true]) {
      for (const [w, h] of [[1024, 640], [800, 640], [600, 640], [420, 560], [1024, 900], [800, 600]] as Array<[number, number]>) {
        const m = make(w, h, undo);
        const place = placeNoticeStack(m);
        sides.add(`${place.float}${place.narrow ? ' narrow' : ''}`);
        const { rows } = stackGeometry(m, place);
        const shown = rows.filter((row) => row.kind === 'notice').length;
        expect(place.fold).toHaveLength(2);
        expect(shown + place.folded).toBe(2);
        expect(place.fold.filter(Boolean)).toHaveLength(place.folded);
        // What folds is counted where the person can open it.
        if (place.folded) {
          expect(place.more).toBe(place.folded);
          expect(rows.some((row) => row.kind === 'more') || place.moreHost >= 0).toBe(true);
        }
      }
    }
    // The walk crosses every placement: beside, beside narrow, and off it.
    expect([...sides].sort()).toEqual(expect.arrayContaining(['right', 'right narrow']));
    expect([...sides].some((side) => side === 'under' || side === 'above')).toBe(true);
    // Written to the stack: moving off the log keeps both notices in place.
    const { region, stack, toasts } = stackDom(2);
    const base: StackPlace = {
      aboveLog: false, lift: 0, cap: 300, mode: 'under', folded: 0, fold: [false, false], more: 0, moreHost: -1, expanded: false,
      keepPlan: false, squeeze: 0, collapse: false, underFade: false, over: 0, float: 'right', inset: { left: 413, right: 16 }, narrow: 339,
    };
    applyNoticeStack(region, stack, base);
    applyNoticeStack(region, stack, { ...base, float: 'under', inset: null, narrow: null }, false, true);
    expect(toasts.every((toast) => toast.isConnected && !toast.hidden && !toast.hasAttribute(FOLD_ATTR) && !toast.hasAttribute('inert'))).toBe(true);
  });

  it('measures the narrow minimum and the card at each room beside the log under 400', () => {
    document.documentElement.style.setProperty('--agent-log-clearance', '348px');
    document.body.innerHTML = `
      <div data-notice-region=""><div class="notice-region__stack">
        <div data-notice-slot="proposal"><div class="card" data-notice-shrinks="">
          <div class="head" data-notice-shrink-head=""><span class="name" data-notice-shrink-name="">Claude</span><span>Expires in 14:55</span></div>
          <div class="scroll" data-notice-shrink-body=""><div class="body"><p class="plan" data-notice-keep="">Plan</p></div></div>
          <div class="foot" data-notice-shrink-foot="">Accept</div>
        </div></div>
      </div></div>`;
    const card = document.querySelector<HTMLElement>('.card')!;
    const width = () => Number.parseFloat(card.style.width) || 600;
    // The footer needs 248 px, the header 238, the name 48 of its 120 past
    // the header's other 220: the name decides, it holds from 268. Narrower, the card is taller.
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return this.matches('.foot') ? 240 : this.matches('.head') ? 230 : this.matches('.name') ? 120 : 0;
    });
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.matches('.name') ? Math.max(0, Math.min(120, width() - 220)) : width() - 8;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.matches('.card') ? (width() < 396 ? 380 : 366) : this.matches('.scroll') ? 266 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { top: 0, bottom: 0, left: this.matches('[data-notice-region]') ? 64 : 0, right: 0, height: 0, width: 0 } as DOMRect;
    });
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    const stack = document.querySelector<HTMLElement>('.notice-region__stack')!;
    vi.stubGlobal('innerHeight', 600);
    // 768: 356 px beside the docked log.
    vi.stubGlobal('innerWidth', 768);
    const m = measureNoticeStack(region, stack, 116);
    expect(m.card).toMatchObject({ narrowMin: 268, probes: [{ width: 356, chrome: 380 - 266 }] });
    expect(m.card!.chrome).toBe(366 - 266);
    expect(card.style.width).toBe('');
    expect(card.style.maxWidth).toBe('');
    expect(narrowMinimum(card)).toBe(268);
    // 600: 172 px, under the minimum: no card read there.
    vi.stubGlobal('innerWidth', 600);
    const short = measureNoticeStack(region, stack, 116);
    expect(short.card!.narrowMin).toBe(268);
    expect(short.card!.probes).toBeUndefined();
    // 1024: 612 px, the normal layout; nothing measured narrow.
    vi.stubGlobal('innerWidth', 1024);
    expect(measureNoticeStack(region, stack, 116).card).not.toHaveProperty('narrowMin');
    // A footer that never fits holds nowhere under 400; new words, read anew.
    document.querySelector('.foot')!.textContent = 'Accept all';
    vi.mocked(Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth')!.get!).mockImplementation(function (this: Element) {
      return this.matches('.foot') ? 500 : 0;
    });
    expect(narrowMinimum(card)).toBe(BESIDE_LOG_MIN_W);
  });
});

describe('the rules', () => {
  it('lifts the stack, never the region, and above the log drops only the log clearance', () => {
    expect(rule(REGION_CSS, '.notice-region__stack')['margin-bottom']).toBe('var(--notice-stack-lift, 0px)');
    expect(rule(REGION_CSS, ".notice-region[data-above-log='true']").right).toBe('var(--page-gutter, 16px)');
    const region = rule(REGION_CSS, '.notice-region');
    expect(region.left).toBe('max(var(--page-gutter, 16px), var(--notice-left-clearance, 0px))');
    expect(region.right).toBe('max(var(--page-gutter, 16px), var(--agent-log-clearance, 0px))');
    expect(rule(RAIL_CSS, ':root:has(.workspace-rail)')['--notice-left-clearance'])
      .toBe('calc(var(--workspace-rail-left) + var(--workspace-rail-width) + 8px)');
  });

  it('caps the card from the region, and only the body between header and footer gives way', () => {
    expect(rule(CARD_CSS, '.proposal-bar')['max-height'])
      .toBe('var(--notice-card-cap, calc(100dvh - var(--notice-region-bottom, 32px) - 72px))');
    expect(CARD_CSS).not.toMatch(/data-above-log|--proposal-bar-lift/);
    expect(rule(CARD_CSS, '.proposal-bar__head')['flex-shrink']).toBe('0');
    expect(rule(CARD_CSS, '.proposal-bar__footer')['flex-shrink']).toBe('0');
    const scroll = rule(CARD_CSS, '.proposal-bar__scroll');
    // The r4 overlay is gone (GM r5): the body keeps no room for notices.
    expect(scroll['min-height']).toBe('0');
    expect(scroll['padding-bottom']).toBeUndefined();
    expect(CARD_CSS + REGION_CSS).not.toMatch(/notice-overlay|notice-body-floor/);
    expect(scroll['box-sizing']).toBe('border-box');
    expect(rule(REGION_CSS, '.notice-region[data-notice-jump] .notice-region__stack').transition).toBe('none');
    expect(scroll.flex).toBe('0 1 auto');
    const body = rule(CARD_CSS, '.proposal-bar__body');
    expect(body['overflow-y']).toBe('auto');
    expect(body['min-height']).toBe('0');
    // "What Accept writes" scrolls with the body, not on its own.
    const details = rule(CARD_CSS, '.proposal-bar__details');
    expect(details['max-height']).toBeUndefined();
    expect(details.overflow).toBeUndefined();
  });

  it('step 2 puts the card last, a folded notice takes no room, clicks or focus, and the row is one 32 px line (GM r5)', () => {
    expect(rule(REGION_CSS, ".notice-region:is([data-notice-mode='above'], [data-notice-mode='folded'], [data-notice-mode='pill']) .notice-region__slot > [data-notice-shrinks]").order).toBe('1');
    // Every step that stands the notices above the card is in that rule
    // (round 3e: the pill was missing, and the card stayed on top).
    const selector = /\.notice-region:is\(([^)]*)\) \.notice-region__slot > \[data-notice-shrinks\] \{\s*order: 1;/.exec(REGION_CSS)?.[1] ?? '';
    expect([...selector.matchAll(/data-notice-mode='(\w+)'/g)].map((match) => match[1]).sort()).toEqual([...ABOVE_MODES].sort());
    expect(REGION_CSS).not.toMatch(/data-notice-mode='under'/);
    const folded = rule(REGION_CSS, '.notice-region .notice-region__slot > [data-notice-folded]');
    expect(folded).toMatchObject({ position: 'absolute', visibility: 'hidden', 'pointer-events': 'none' });
    const more = rule(REGION_CSS, '.notice-region__more');
    expect(more.display).toBe('none');
    expect(more.height).toBe(`${MORE_ROW_PX}px`);
    expect(more['pointer-events']).toBe('auto');
    // It keeps the app's focus ring (no outline rule of its own).
    expect(more.outline).toBeUndefined();
    expect(rule(REGION_CSS, '.notice-region[data-notice-more-shown] .notice-region__more').display).toBe('inline-flex');
    // A real button, first in the stack, its click unfolding and folding.
    expect(REGION).toMatch(/<button type="button" className="notice-region__more" \{\.\.\.\{ \[MORE_ATTR\]: '' \}\} hidden onClick=\{toggleMore\} \/>/);
    expect(REGION).toMatch(/placeNoticeStack\(measured, \{ expanded: expanded\.current \}\)/);
    expect(REGION).toMatch(/expanded\.current = !expanded\.current;\s*place\(\);/);
    expect(REGION).toMatch(/if \(!next\.place\.expanded\) expanded\.current = false;/);
    // The plan line carries the mark the region keeps in view.
    const bar = readFileSync(join(__dirname, '../src/components/canvas/ProposalBar.tsx'), 'utf8');
    expect(bar).toMatch(/<p className="proposal-bar__plan" \{\.\.\.\{ \[KEEP_ATTR\]: '' \}\}>/);
  });

  it('fades 16 px on the edge that hides content, and draws the focus ring outside the mask', () => {
    const body = rule(CARD_CSS, '.proposal-bar__body');
    expect(body['mask-image']).toBe('linear-gradient(to bottom, transparent 0, #000 var(--proposal-fade-top), '
      + '#000 calc(100% - var(--proposal-fade-bottom)), transparent 100%)');
    expect(body['--proposal-fade-top']).toBe('0px');
    expect(rule(CARD_CSS, ".proposal-bar__body[data-fade-top='true']")['--proposal-fade-top']).toBe('16px');
    expect(rule(CARD_CSS, ".proposal-bar__body[data-fade-bottom='true']")['--proposal-fade-bottom']).toBe('16px');
    expect(rule(CARD_CSS, '.proposal-bar__body:focus-visible').outline).toBe('none');
    expect(rule(CARD_CSS, '.proposal-bar__scroll:has(> .proposal-bar__body:focus-visible)').outline)
      .toBe('var(--sr-focus-outline, 2px solid #fff)');
    // Reduced motion changes nothing: the fades never animate.
    expect(CARD_CSS).not.toMatch(/transition:[^;]*mask/);
  });
});
