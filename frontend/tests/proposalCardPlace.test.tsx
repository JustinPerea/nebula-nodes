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
    const low = placeNoticeStack({ ...base, card, floating: { top: 500, bottom: 760, left: 65, right: 403 } });
    expect(low.lift).toBe(900 - 500 + FLOAT_GAP_PX - LIVE.regionBottom);
    const aside = placeNoticeStack({ ...base, card, floating: { top: 500, bottom: 760, left: 600, right: 900 } });
    expect(aside.lift).toBe(0);
    expect(aside.topLine).toBe(LIVE.topLine);
    // With room, a floating log never gives way.
    expect(high.squeeze).toBe(0);
    expect(low.squeeze).toBe(0);
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

  it('a floating log with no room on either side: the stack stays under it, crossing its body, never its header', () => {
    const m: StackMeasure = {
      ...at(560, 2), logClearance: 0, logTop: 0, logCollapse: 0, column: { left: 64, right: 404 },
      floating: { top: 150, bottom: 470, left: 65, right: 403 },
    };
    const place = placeNoticeStack(m);
    expect(place).toMatchObject({ lift: 0, squeeze: 0, collapse: false, topLine: 470 + FLOAT_GAP_PX });
    const { card, rows } = stackGeometry(m, place);
    for (const box of [card!, ...rows]) expect(box.top).toBeGreaterThanOrEqual(150 + 37);
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
  '420x560 open 1 banner': [85, 97],
  '420x560 open 1 banner undo': [71, 97],
  '420x560 open 2 banner': [85, 97],
  '420x560 open 2 banner undo': [71, 97],
  '420x560 open 3 banner': [85, 97],
  '420x560 open 3 banner undo': [71, 97],
  '420x560 open 4 banner': [85, 97],
  '420x560 open 4 banner undo': [71, 97],
  '420x560 closed 1 banner': [85, 97],
  '420x560 closed 1 banner undo': [71, 97],
  '420x560 closed 2 banner': [85, 97],
  '420x560 closed 2 banner undo': [71, 97],
  '420x560 closed 3 banner': [85, 97],
  '420x560 closed 3 banner undo': [71, 97],
  '420x560 closed 4 banner': [85, 97],
  '420x560 closed 4 banner undo': [71, 97],
  '420x560 floating 0': [91, 97],
  '420x560 floating 0 banner': [34, 97],
  '420x560 floating 1': [51, 97],
  '420x560 floating 1 undo': [37, 97],
  '420x560 floating 1 banner': [20, 97],
  '420x560 floating 1 banner undo': [20, 97],
  '420x560 floating 2': [51, 97],
  '420x560 floating 2 undo': [37, 97],
  '420x560 floating 2 banner': [20, 97],
  '420x560 floating 2 banner undo': [20, 97],
  '420x560 floating 3': [51, 97],
  '420x560 floating 3 undo': [37, 97],
  '420x560 floating 3 banner': [20, 97],
  '420x560 floating 3 banner undo': [20, 97],
  '420x560 floating 4': [51, 97],
  '420x560 floating 4 undo': [37, 97],
  '420x560 floating 4 banner': [20, 97],
  '420x560 floating 4 banner undo': [20, 97],
  '420x560 floating wide 0': [91, 97],
  '420x560 floating wide 0 banner': [34, 97],
  '420x560 floating wide 1': [51, 97],
  '420x560 floating wide 1 undo': [37, 97],
  '420x560 floating wide 1 banner': [20, 97],
  '420x560 floating wide 1 banner undo': [20, 97],
  '420x560 floating wide 2': [51, 97],
  '420x560 floating wide 2 undo': [37, 97],
  '420x560 floating wide 2 banner': [20, 97],
  '420x560 floating wide 2 banner undo': [20, 97],
  '420x560 floating wide 3': [51, 97],
  '420x560 floating wide 3 undo': [37, 97],
  '420x560 floating wide 3 banner': [20, 97],
  '420x560 floating wide 3 banner undo': [20, 97],
  '420x560 floating wide 4': [51, 97],
  '420x560 floating wide 4 undo': [37, 97],
  '420x560 floating wide 4 banner': [20, 97],
  '420x560 floating wide 4 banner undo': [20, 97],
  '420x640 floating 0 banner': [90, 97],
  '420x640 floating 1': [75, 97],
  '420x640 floating 1 undo': [61, 97],
  '420x640 floating 1 banner': [50, 97],
  '420x640 floating 1 banner undo': [36, 97],
  '420x640 floating 2': [75, 97],
  '420x640 floating 2 undo': [61, 97],
  '420x640 floating 2 banner': [50, 97],
  '420x640 floating 2 banner undo': [36, 97],
  '420x640 floating 3': [75, 97],
  '420x640 floating 3 undo': [61, 97],
  '420x640 floating 3 banner': [50, 97],
  '420x640 floating 3 banner undo': [36, 97],
  '420x640 floating 4': [75, 97],
  '420x640 floating 4 undo': [61, 97],
  '420x640 floating 4 banner': [50, 97],
  '420x640 floating 4 banner undo': [36, 97],
  '420x640 floating wide 0 banner': [90, 97],
  '420x640 floating wide 1': [75, 97],
  '420x640 floating wide 1 undo': [61, 97],
  '420x640 floating wide 1 banner': [50, 97],
  '420x640 floating wide 1 banner undo': [36, 97],
  '420x640 floating wide 2': [75, 97],
  '420x640 floating wide 2 undo': [61, 97],
  '420x640 floating wide 2 banner': [50, 97],
  '420x640 floating wide 2 banner undo': [36, 97],
  '420x640 floating wide 3': [75, 97],
  '420x640 floating wide 3 undo': [61, 97],
  '420x640 floating wide 3 banner': [50, 97],
  '420x640 floating wide 3 banner undo': [36, 97],
  '420x640 floating wide 4': [75, 97],
  '420x640 floating wide 4 undo': [61, 97],
  '420x640 floating wide 4 banner': [50, 97],
  '420x640 floating wide 4 banner undo': [36, 97],
  '768x600 floating 0': [69, 97],
  '768x600 floating 0 banner': [62, 97],
  '768x600 floating 1': [29, 97],
  '768x600 floating 1 undo': [20, 97],
  '768x600 floating 1 banner': [22, 97],
  '768x600 floating 1 banner undo': [20, 97],
  '768x600 floating 2': [29, 97],
  '768x600 floating 2 undo': [20, 97],
  '768x600 floating 2 banner': [22, 97],
  '768x600 floating 2 banner undo': [20, 97],
  '768x600 floating 3': [29, 97],
  '768x600 floating 3 undo': [20, 97],
  '768x600 floating 3 banner': [22, 97],
  '768x600 floating 3 banner undo': [20, 97],
  '768x600 floating 4': [29, 97],
  '768x600 floating 4 undo': [20, 97],
  '768x600 floating 4 banner': [22, 97],
  '768x600 floating 4 banner undo': [20, 97],
  '768x600 floating wide 0': [69, 97],
  '768x600 floating wide 0 banner': [62, 97],
  '768x600 floating wide 1': [29, 97],
  '768x600 floating wide 1 undo': [20, 97],
  '768x600 floating wide 1 banner': [22, 97],
  '768x600 floating wide 1 banner undo': [20, 97],
  '768x600 floating wide 2': [29, 97],
  '768x600 floating wide 2 undo': [20, 97],
  '768x600 floating wide 2 banner': [22, 97],
  '768x600 floating wide 2 banner undo': [20, 97],
  '768x600 floating wide 3': [29, 97],
  '768x600 floating wide 3 undo': [20, 97],
  '768x600 floating wide 3 banner': [22, 97],
  '768x600 floating wide 3 banner undo': [20, 97],
  '768x600 floating wide 4': [29, 97],
  '768x600 floating wide 4 undo': [20, 97],
  '768x600 floating wide 4 banner': [22, 97],
  '768x600 floating wide 4 banner undo': [20, 97],
  '1024x640 floating wide 0': [90, 97],
  '1024x640 floating wide 0 banner': [90, 97],
  '1024x640 floating wide 1': [50, 97],
  '1024x640 floating wide 1 undo': [36, 97],
  '1024x640 floating wide 1 banner': [50, 97],
  '1024x640 floating wide 1 banner undo': [36, 97],
  '1024x640 floating wide 2': [50, 97],
  '1024x640 floating wide 2 undo': [36, 97],
  '1024x640 floating wide 2 banner': [50, 97],
  '1024x640 floating wide 2 banner undo': [36, 97],
  '1024x640 floating wide 3': [50, 97],
  '1024x640 floating wide 3 undo': [36, 97],
  '1024x640 floating wide 3 banner': [50, 97],
  '1024x640 floating wide 3 banner undo': [36, 97],
  '1024x640 floating wide 4': [50, 97],
  '1024x640 floating wide 4 undo': [36, 97],
  '1024x640 floating wide 4 banner': [50, 97],
  '1024x640 floating wide 4 banner undo': [36, 97],
};
// Of those, where even the plan line alone (33 + two fades = 65) can't show
// whole, [the body, 65]: it is centred between the fades.
const EXPECTED_PLAN_SHORT: Record<string, [number, number]> = {
  '420x560 floating 0 banner': [34, 65],
  '420x560 floating 1': [51, 65],
  '420x560 floating 1 undo': [37, 65],
  '420x560 floating 1 banner': [20, 65],
  '420x560 floating 1 banner undo': [20, 65],
  '420x560 floating 2': [51, 65],
  '420x560 floating 2 undo': [37, 65],
  '420x560 floating 2 banner': [20, 65],
  '420x560 floating 2 banner undo': [20, 65],
  '420x560 floating 3': [51, 65],
  '420x560 floating 3 undo': [37, 65],
  '420x560 floating 3 banner': [20, 65],
  '420x560 floating 3 banner undo': [20, 65],
  '420x560 floating 4': [51, 65],
  '420x560 floating 4 undo': [37, 65],
  '420x560 floating 4 banner': [20, 65],
  '420x560 floating 4 banner undo': [20, 65],
  '420x560 floating wide 0 banner': [34, 65],
  '420x560 floating wide 1': [51, 65],
  '420x560 floating wide 1 undo': [37, 65],
  '420x560 floating wide 1 banner': [20, 65],
  '420x560 floating wide 1 banner undo': [20, 65],
  '420x560 floating wide 2': [51, 65],
  '420x560 floating wide 2 undo': [37, 65],
  '420x560 floating wide 2 banner': [20, 65],
  '420x560 floating wide 2 banner undo': [20, 65],
  '420x560 floating wide 3': [51, 65],
  '420x560 floating wide 3 undo': [37, 65],
  '420x560 floating wide 3 banner': [20, 65],
  '420x560 floating wide 3 banner undo': [20, 65],
  '420x560 floating wide 4': [51, 65],
  '420x560 floating wide 4 undo': [37, 65],
  '420x560 floating wide 4 banner': [20, 65],
  '420x560 floating wide 4 banner undo': [20, 65],
  '420x640 floating 1 undo': [61, 65],
  '420x640 floating 1 banner': [50, 65],
  '420x640 floating 1 banner undo': [36, 65],
  '420x640 floating 2 undo': [61, 65],
  '420x640 floating 2 banner': [50, 65],
  '420x640 floating 2 banner undo': [36, 65],
  '420x640 floating 3 undo': [61, 65],
  '420x640 floating 3 banner': [50, 65],
  '420x640 floating 3 banner undo': [36, 65],
  '420x640 floating 4 undo': [61, 65],
  '420x640 floating 4 banner': [50, 65],
  '420x640 floating 4 banner undo': [36, 65],
  '420x640 floating wide 1 undo': [61, 65],
  '420x640 floating wide 1 banner': [50, 65],
  '420x640 floating wide 1 banner undo': [36, 65],
  '420x640 floating wide 2 undo': [61, 65],
  '420x640 floating wide 2 banner': [50, 65],
  '420x640 floating wide 2 banner undo': [36, 65],
  '420x640 floating wide 3 undo': [61, 65],
  '420x640 floating wide 3 banner': [50, 65],
  '420x640 floating wide 3 banner undo': [36, 65],
  '420x640 floating wide 4 undo': [61, 65],
  '420x640 floating wide 4 banner': [50, 65],
  '420x640 floating wide 4 banner undo': [36, 65],
  '768x600 floating 0 banner': [62, 65],
  '768x600 floating 1': [29, 65],
  '768x600 floating 1 undo': [20, 65],
  '768x600 floating 1 banner': [22, 65],
  '768x600 floating 1 banner undo': [20, 65],
  '768x600 floating 2': [29, 65],
  '768x600 floating 2 undo': [20, 65],
  '768x600 floating 2 banner': [22, 65],
  '768x600 floating 2 banner undo': [20, 65],
  '768x600 floating 3': [29, 65],
  '768x600 floating 3 undo': [20, 65],
  '768x600 floating 3 banner': [22, 65],
  '768x600 floating 3 banner undo': [20, 65],
  '768x600 floating 4': [29, 65],
  '768x600 floating 4 undo': [20, 65],
  '768x600 floating 4 banner': [22, 65],
  '768x600 floating 4 banner undo': [20, 65],
  '768x600 floating wide 0 banner': [62, 65],
  '768x600 floating wide 1': [29, 65],
  '768x600 floating wide 1 undo': [20, 65],
  '768x600 floating wide 1 banner': [22, 65],
  '768x600 floating wide 1 banner undo': [20, 65],
  '768x600 floating wide 2': [29, 65],
  '768x600 floating wide 2 undo': [20, 65],
  '768x600 floating wide 2 banner': [22, 65],
  '768x600 floating wide 2 banner undo': [20, 65],
  '768x600 floating wide 3': [29, 65],
  '768x600 floating wide 3 undo': [20, 65],
  '768x600 floating wide 3 banner': [22, 65],
  '768x600 floating wide 3 banner undo': [20, 65],
  '768x600 floating wide 4': [29, 65],
  '768x600 floating wide 4 undo': [20, 65],
  '768x600 floating wide 4 banner': [22, 65],
  '768x600 floating wide 4 banner undo': [20, 65],
  '1024x640 floating wide 1': [50, 65],
  '1024x640 floating wide 1 undo': [36, 65],
  '1024x640 floating wide 1 banner': [50, 65],
  '1024x640 floating wide 1 banner undo': [36, 65],
  '1024x640 floating wide 2': [50, 65],
  '1024x640 floating wide 2 undo': [36, 65],
  '1024x640 floating wide 2 banner': [50, 65],
  '1024x640 floating wide 2 banner undo': [36, 65],
  '1024x640 floating wide 3': [50, 65],
  '1024x640 floating wide 3 undo': [36, 65],
  '1024x640 floating wide 3 banner': [50, 65],
  '1024x640 floating wide 3 banner undo': [36, 65],
  '1024x640 floating wide 4': [50, 65],
  '1024x640 floating wide 4 undo': [36, 65],
  '1024x640 floating wide 4 banner': [50, 65],
  '1024x640 floating wide 4 banner undo': [36, 65],
};

const EXPECTED_R9_OWN = [18, 0, 53];
const EXPECTED_R9_WIDE = [0, 0, 71];

describe('the grid', () => {
  const SIZES: Array<[number, number]> = [[420, 560], [420, 640], [420, 760], [420, 900], [768, 600], [1024, 640], [1440, 900]];
  // `floating`: the log at its own width (layouts.css --col-right-w:
  // clamp(340px, 26vw, 460px)), its left edge at the card's column's, where
  // the person left it; `floating wide`: resized to the column's width (round
  // 3f's grid had only this one, as `floating`).
  const LOGS = ['open', 'closed', 'floating', 'floating wide'] as const;
  const COUNTS = [0, 1, 2, 3, 4];
  const LOG_HEADER = 37;
  const FLOOR = 91;
  const SHORT: Record<string, [number, number]> = {};
  const PLAN_SHORT: Record<string, [number, number]> = {};
  /** Where the stack sits by each floating log (GM r9). */
  const SIDE: Record<string, string> = {};
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
        ...LIVE_CARD, items: Array(count).fill(46),
        undo: Array(count).fill(false).map((_, i) => undo && i === count - 1),
        host: Array(count).fill(false).map((_, i) => undo && i === count - 1),
      },
      floating: floating ? { top: Math.round(h * 0.3), bottom: Math.round(h * 0.3) + natural, left: column.left + 1, right: column.left + 1 + logW } : null,
      column,
    };
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
    const floors = bodyFloors(m.card!);
    const give = place.squeeze + (place.collapse ? m.logCollapse! : 0);
    if (place.squeeze > 0) expect(place.mode === 'pill' || place.mode === 'under' || !rows.some((row) => row.kind === 'notice' && !undo)).toBe(true);
    if (place.collapse) expect(place.squeeze).toBe(m.logSpare);
    if (place.underFade) {
      expect(give).toBe(place.aboveLog || (floating && give > 0) ? m.logSpare! + m.logCollapse! : give);
      SHORT[name] = [place.cap! - 89, floors.min];
      // The plan line first, whole between the fades.
      if (place.cap! - 89 >= floors.one) {
        expect(card!.first!.top).toBeGreaterThanOrEqual(card!.headBottom);
        expect(card!.first!.bottom).toBeLessThanOrEqual(card!.footTop - FADE_PX);
      } else {
        PLAN_SHORT[name] = [place.cap! - 89, floors.one];
      }
    } else {
      expect(card!.plan!.top).toBeGreaterThanOrEqual(card!.headBottom);
      expect(card!.plan!.bottom).toBeLessThanOrEqual(card!.footTop - FADE_PX);
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
    // A floating log (GM r9): beside it, with at least 400 px there, the
    // region stopping short of it; else under it, above it (its top come
    // down by its give), or, with no room either side, under it crossing its
    // body; never its header.
    let crossing = false;
    if (floating) SIDE[name] = place.float ?? 'none';
    if (floating && (place.float === 'left' || place.float === 'right')) {
      const float = m.floating!;
      const inset = place.inset!;
      expect(m.viewportW - inset.right - inset.left).toBeGreaterThanOrEqual(BESIDE_LOG_MIN_W);
      if (place.float === 'left') expect(m.viewportW - inset.right).toBeLessThanOrEqual(float.left - FLOAT_GAP_PX);
      else expect(inset.left).toBeGreaterThanOrEqual(float.right + FLOAT_GAP_PX);
      expect(inset.left).toBeGreaterThanOrEqual(m.regionLeft);
      expect(place).toMatchObject({ squeeze: 0, collapse: false });
    } else if (floating) {
      expect(place.inset ?? null).toBeNull();
      const float = m.floating!;
      const top = float.top + give;
      crossing = place.topLine! > m.topLine && boxes.some((box) => box.top < float.bottom);
      for (const box of boxes) {
        if (crossing) expect(box.top >= top + LOG_HEADER || box.bottom <= top).toBe(true);
        else expect(box.bottom <= top - FLOAT_GAP_PX + 0.5 || box.top >= float.bottom).toBe(true);
      }
    }
    // Nothing off screen; nothing past the top line.
    for (const box of boxes) {
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(m.viewportH);
      if (!crossing && !place.over) expect(box.top).toBeGreaterThanOrEqual(place.topLine ?? m.topLine);
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

  it('GM r9: how round 3f\'s 71 floating cells resolve, step by step', () => {
    // 1: beside the log; 2: a side of it (under, or above with its give)
    // that holds the kept lines; else 3: a named shortfall (SHORT).
    const step = (name: string) => (SIDE[name] === 'left' || SIDE[name] === 'right' ? 1 : SHORT[name] ? 3 : 2);
    const count = (names: string[]) => [1, 2, 3].map((n) => names.filter((name) => step(name) === n).length);
    // With the log at its own width.
    const own = R3F_FLOATING_SHORT;
    expect(count(own)).toEqual(EXPECTED_R9_OWN);
    // Step 1 takes every 1024x640 cell (595 px beside the log, on its
    // right); the ones left are those in SHORT, with their numbers: at 420
    // the log is the column's width, at 768 there are 339 px beside it.
    expect(own.filter((name) => step(name) === 1).every((name) => name.startsWith('1024x640'))).toBe(true);
    expect(own.filter((name) => step(name) === 3)).toEqual(Object.keys(EXPECTED_SHORT).filter((name) => / floating (?!wide)/.test(name)));
    // With it resized to the column's width, as round 3f's grid had it.
    const wide = R3F_FLOATING_SHORT.map((name) => name.replace(' floating', ' floating wide'));
    expect(count(wide)).toEqual(EXPECTED_R9_WIDE);
  });

  it('lists the cells where every step leaves the body short of its kept lines', () => {
    // [the body it gets, the kept lines' need (65 + two fades)].
    expect(SHORT).toEqual(EXPECTED_SHORT);
    for (const [body, need] of Object.values(SHORT)) expect(body).toBeLessThan(need);
    // The plan line shows whole in every one of them but these.
    expect(PLAN_SHORT).toEqual(EXPECTED_PLAN_SHORT);
    for (const [body, need] of Object.values(PLAN_SHORT)) expect(body).toBeLessThan(need);
    // GM r7's cells: 420x560, the docked log, the banner, 2-4 notices with
    // no Undo: the plan line whole, the ⚠ line 12 px short (under the fade).
    for (const count of [2, 3, 4]) {
      expect(SHORT[`420x560 open ${count} banner`]).toEqual([85, 97]);
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
    vi.mocked(window.getComputedStyle).mockReturnValue({ transform: 'none' } as CSSStyleDeclaration);
    expect(layoutBox(card)).toEqual({ top: 104, bottom: 248, height: 144, left: 40 });
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
