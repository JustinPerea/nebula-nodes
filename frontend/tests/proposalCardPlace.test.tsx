import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BESIDE_LOG_MIN_W,
  FADE_PX,
  FLOAT_GAP_PX,
  FOLD_ATTR,
  GLIDE_MS,
  JUMP_ATTR,
  MIN_BODY_PX,
  MORE_ROW_PX,
  MORE_SHOWN_ATTR,
  LOG_SQUEEZE_VAR,
  SHOW_LESS,
  applyNoticeStack,
  bodyFloors,
  glideStack,
  layoutBox,
  measureNoticeStack,
  moreLabel,
  placeNoticeStack,
  stackGeometry,
  stackJumps,
  stepChanged,
  type StackMeasure,
  type StackPlace,
} from '../src/lib/noticeStackPlace';
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

// GM - Design, PR #216 r5-r6, on the live check's numbers (round 3d, 420
// wide, the log open): region line 81 up, the log's top line 268 up (its
// height 180 with no give, its floor of header and 2 rows 91), the top line
// 116 (the selection toolbar's empty Panel keeps its room, so a selection
// never moves the card), header 34 + footer 53 + borders, the plan line at
// 77 and the first ⚠ row's foot at 142 in a 198 px body, notices 46 tall
// with 8 px gaps.
const LIVE = {
  viewportW: 420, viewportH: 560, gutter: 16, regionLeft: 64, regionBottom: 81,
  logClearance: 348, logTop: 268, topLine: 116, logSpare: 180 - 91,
};
const PLAN = { top: 77, bottom: 142 };
const LIVE_CARD = { chrome: 89, body: 198, foot: 54, line: 20, gap: 8, plan: PLAN };
const at = (viewportH: number, count: number, over: Partial<StackMeasure> = {}): StackMeasure => ({
  ...LIVE, viewportH, card: { ...LIVE_CARD, items: Array(count).fill(46) }, ...over,
});
/** The room from the log's line to the top line. */
const roomAt = (viewportH: number) => viewportH - LIVE.logTop - LIVE.topLine;
const BASE = LIVE.logTop - LIVE.regionBottom;
/** Header and footer, and the kept lines between two fades. */
const KEEP = 89 + (142 - 77) + 2 * FADE_PX;

describe('the card body keeps its kept lines (GM r5-r6)', () => {
  it('full: note and kept lines whole, the fade under them; min: the kept lines alone between two fades', () => {
    expect(bodyFloors(LIVE_CARD)).toEqual({ full: 142 + FADE_PX, min: 65 + 2 * FADE_PX });
    // Without a ⚠ row, the plan line alone.
    expect(bodyFloors({ ...LIVE_CARD, plan: { top: 77, bottom: 110 } })).toEqual({ full: 110 + FADE_PX, min: 33 + 2 * FADE_PX });
    // A short body needs no more than itself.
    expect(bodyFloors({ ...LIVE_CARD, body: 90, plan: { top: 40, bottom: 80 } })).toEqual({ full: 90, min: 40 + 2 * FADE_PX });
    // No plan line: the old minimum, and one line.
    expect(bodyFloors({ chrome: 89, body: 198 })).toEqual({ full: MIN_BODY_PX, min: 20 });
  });
});

describe('the give-way order (GM r5-r6)', () => {
  it('0: the notices stay under the card while its body keeps note and kept lines whole', () => {
    const m = at(700, 1);
    const place = placeNoticeStack(m);
    expect(place).toMatchObject({ mode: 'under', cap: roomAt(700) - 54, folded: 0, more: 0, keepPlan: false, squeeze: 0, underFade: false, over: 0 });
    const { card, rows } = stackGeometry(m, place);
    expect(rows[0].top).toBe(card!.bottom + 8);
  });

  it('1 holds no more room than 0, so step 0\'s floor goes straight on to 2: the notices move above', () => {
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

  it('2: above, the body gives up the note before the kept lines', () => {
    const lowest = LIVE.logTop + LIVE.topLine + 108 + KEEP;
    const place = placeNoticeStack(at(lowest, 2));
    expect(place).toMatchObject({ mode: 'above', cap: KEEP, squeeze: 0 });
    expect(placeNoticeStack(at(lowest - 1, 2)).mode).toBe('folded');
  });

  it('3: no room above for them all, the older ones fold into one row over the newest', () => {
    const m = at(670, 2);
    const place = placeNoticeStack(m);
    expect(place).toMatchObject({ mode: 'folded', folded: 1, more: 1, expanded: false, cap: roomAt(670) - (MORE_ROW_PX + 8 + 46 + 8), squeeze: 0, over: 0 });
    const { card, rows } = stackGeometry(m, place);
    expect(rows.map((row) => row.kind)).toEqual(['more', 'notice']);
    expect(rows[1].bottom + 8).toBe(card!.top);
    expect(placeNoticeStack(at(670, 4))).toMatchObject({ mode: 'folded', folded: 3, more: 3 });
    expect(moreLabel(1)).toBe('1 more notice');
    expect(moreLabel(3)).toBe('3 more notices');
    // One notice has nothing older to fold: it stays whole, above.
    expect(placeNoticeStack(at(560, 1)).mode).toBe('above');
  });

  it('3, unfolded on click: every notice above the card under the row, until it folds again', () => {
    const m = at(670, 3);
    const place = placeNoticeStack(m, { expanded: true });
    expect(place).toMatchObject({ mode: 'above', folded: 0, more: 2, expanded: true });
    const { rows } = stackGeometry(m, place);
    expect(rows.map((row) => row.kind)).toEqual(['more', 'notice', 'notice', 'notice']);
    expect(placeNoticeStack(at(900, 3), { expanded: true })).toMatchObject({ more: 0, expanded: false });
  });

  it('4: past step 3 the docked log\'s body gives way, down to its floor, before the kept lines go under the fade', () => {
    // No notice at 420x560: 10 px of the log's body.
    expect(placeNoticeStack(at(560, 0))).toMatchObject({ mode: 'under', cap: KEEP, squeeze: KEEP - roomAt(560), underFade: false, over: 0 });
    // One: above, the log gives 64.
    const one = placeNoticeStack(at(560, 1));
    expect(one).toMatchObject({ mode: 'above', cap: KEEP, squeeze: KEEP + 54 - roomAt(560), underFade: false, over: 0 });
    expect(one.lift).toBe(BASE - one.squeeze);
    // Two: folded, the log down to its floor (89), and the body 15 px under its kept lines.
    const two = placeNoticeStack(at(560, 2));
    expect(two).toMatchObject({ mode: 'folded', squeeze: LIVE.logSpare, underFade: true, over: 0 });
    expect(two.cap).toBe(roomAt(560) - 94 + LIVE.logSpare);
    expect(two.lift).toBe(BASE - LIVE.logSpare);
    // A log with no give: the body goes under the fade at once, down to one line, then the foot.
    const stiff = placeNoticeStack(at(560, 2, { logSpare: 0 }));
    expect(stiff).toMatchObject({ squeeze: 0, underFade: true, cap: 89 + 20, over: 89 + 20 - (roomAt(560) - 94) });
    // Beside the log (wide), nothing to give.
    expect(placeNoticeStack(at(560, 2, { viewportW: 1440 })).squeeze).toBe(0);
  });

  it('a body shorter than the minimum needs no give-way (review 2 NIT-5)', () => {
    const line = LIVE.viewportH - LIVE.logTop;
    const m: StackMeasure = { ...LIVE, topLine: line - 54 - (89 + 30), card: { ...LIVE_CARD, body: 30, plan: null, items: [46] } };
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
    // A floating log never gives way.
    expect(high.squeeze).toBe(0);
  });

  it('a floating log with no room on either side: the stack stays under it, crossing its body, never its header', () => {
    const m: StackMeasure = {
      ...at(560, 2), logClearance: 0, logTop: 0, column: { left: 64, right: 404 },
      floating: { top: 150, bottom: 470, left: 65, right: 403 },
    };
    const place = placeNoticeStack(m);
    expect(place).toMatchObject({ lift: 0, squeeze: 0, topLine: 470 + FLOAT_GAP_PX });
    const { card, rows } = stackGeometry(m, place);
    for (const box of [card!, ...rows]) expect(box.top).toBeGreaterThanOrEqual(150 + 37);
  });

  it('a layout switch lands with no spring for its frame; a give-way step glides; a notice coming or going keeps the spring', () => {
    const place = (aboveLog: boolean, mode: StackPlace['mode'] = 'under', folded = 0, more = 0): StackPlace => ({
      aboveLog, lift: 0, cap: null, mode, folded, more, expanded: false, keepPlan: false, squeeze: 0, underFade: false, over: 0,
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
    expect(stepChanged(place(true, 'above'), { ...place(true, 'above'), cap: 300 })).toBe(false);
  });
});

/**
 * The invariants in every cell of the grid (GM r5-r6): window sizes, the
 * log open (docked), closed or floating in the card's column, 0-4 notices,
 * the offline banner on or off. Nothing on the never-covered list is
 * covered (the card's header and footer; the docked log's header), no
 * notice overlaps another, nothing leaves the window or passes the top line.
 * The kept lines show whole, but where the docked log has given all it can
 * (its floor) and the card's body still goes under them. The cells that
 * can't hold even header, one line and footer, and so cross the log's line,
 * are physically impossible: IMPOSSIBLE lists each with its numbers.
 */
describe('the grid', () => {
  const SIZES: Array<[number, number]> = [[420, 560], [420, 640], [420, 760], [420, 900], [768, 600], [1024, 640], [1440, 900]];
  const LOGS = ['open', 'closed', 'floating'] as const;
  const COUNTS = [0, 1, 2, 3, 4];
  const LOG_HEADER = 37;
  const FLOOR = 91;
  // name: [room to the log's top line, the log's give, what the smallest stack needs (header, one line, footer, the "more" row and the newest)]
  const IMPOSSIBLE: Record<string, [number, number, number]> = {};
  // The cells where the body goes under its kept lines (the log at its floor).
  const UNDER_FADE: string[] = [];
  const cells = SIZES.flatMap(([w, h]) => LOGS.flatMap((log) => COUNTS.flatMap((count) => [false, true].map((banner) => {
    const regionLeft = 64;
    const column = { left: regionLeft, right: regionLeft + Math.min(600, w - regionLeft - 16) };
    // The live top lines (round 3d shots): the top bars' bottom plus 8, or
    // the offline banner's bottom plus 16 (it wraps to two lines at 420).
    const topLine = banner ? (w < 600 ? 214 : 199) : (w < 600 ? 116 : 150);
    // The open log's own height (layouts.css --agent-h-open: clamp(180px, 22vh, 280px)).
    const natural = Math.min(280, Math.max(180, Math.round(h * 0.22)));
    const m: StackMeasure = {
      viewportW: w, viewportH: h, gutter: 16, regionLeft, regionBottom: 81,
      logClearance: log === 'open' ? 348 : 0, logTop: log === 'open' ? natural + 88 : 0,
      logSpare: log === 'open' ? natural - FLOOR : 0,
      topLine,
      card: { ...LIVE_CARD, items: Array(count).fill(46) },
      floating: log === 'floating' ? { top: Math.round(h * 0.3), bottom: Math.round(h * 0.3) + 180, left: column.left + 1, right: column.right - 1 } : null,
      column,
    };
    return { name: `${w}x${h} ${log} ${count}${banner ? ' banner' : ''}`, m, log, count };
  }))));

  it('covers the whole grid', () => {
    expect(cells).toHaveLength(SIZES.length * LOGS.length * COUNTS.length * 2);
  });

  it.each(cells.map((cell) => [cell.name, cell] as const))('%s', (_name, { name, m, log, count }) => {
    const place = placeNoticeStack(m);
    const { card, rows, line } = stackGeometry(m, place);
    expect(card).not.toBeNull();
    const boxes = [{ top: card!.top, bottom: card!.bottom }, ...rows];
    // No notice overlaps another, or the card (its header and footer among it).
    const all = [...boxes].sort((a, b) => a.top - b.top);
    for (let i = 1; i < all.length; i += 1) expect(all[i].top).toBeGreaterThanOrEqual(all[i - 1].bottom);
    // Header and footer whole, at least one line between them.
    expect(card!.footTop - card!.headBottom).toBeGreaterThanOrEqual(20);
    // The kept lines show whole between the two fades, but where the log is at its floor.
    if (place.underFade) UNDER_FADE.push(name);
    if (place.underFade) expect(place.squeeze).toBe(place.aboveLog && log === 'open' ? m.logSpare : 0);
    else {
      expect(card!.plan!.top).toBeGreaterThanOrEqual(card!.headBottom);
      expect(card!.plan!.bottom).toBeLessThanOrEqual(card!.footTop - FADE_PX);
    }
    // The newest notice always shows whole; the older ones whole or in the row.
    if (count) expect(rows.filter((row) => row.kind === 'notice').length).toBe(place.folded ? 1 : count);
    if (count > 1 && place.folded) expect(rows[0].kind).toBe('more');
    // A floating log: as round 3c (under it when neither side has the room, its header clear).
    let neither = false;
    if (log === 'floating') {
      const float = m.floating!;
      const needs = 89 + 97 + (count === 0 ? 0 : count === 1 ? 54 : 32 + 8 + 54);
      const room = { under: m.viewportH - m.regionBottom - (float.bottom + FLOAT_GAP_PX), over: float.top - FLOAT_GAP_PX - m.topLine };
      neither = float.top < m.viewportH - m.regionBottom && room.under < needs && room.over < needs;
      if (!neither) for (const box of boxes) expect(box.bottom <= float.top || box.top >= float.bottom).toBe(true);
      for (const box of boxes) expect(box.top >= float.top + LOG_HEADER || box.bottom <= float.top).toBe(true);
    }
    // Nothing off screen; nothing past the top line.
    for (const box of boxes) {
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(m.viewportH);
      if (!neither && !place.over) expect(box.top).toBeGreaterThanOrEqual(place.topLine ?? m.topLine);
    }
    // The docked log: its body gives at most down to its floor, and nothing
    // reaches its header (now at its top line plus the give), but in the
    // impossible cells.
    if (log === 'open' && place.aboveLog) {
      expect(place.squeeze).toBeLessThanOrEqual(m.logSpare!);
      const header = m.viewportH - m.logTop + 8 + place.squeeze;
      expect(line).toBe(header - 8 + place.over);
      if (place.over > 0) {
        const rowsNeeded = count === 0 ? 0 : count === 1 ? 54 : 94;
        IMPOSSIBLE[name] = [m.viewportH - m.logTop - m.topLine, m.logSpare!, 89 + 20 + rowsNeeded];
      } else {
        for (const box of boxes) expect(box.bottom).toBeLessThanOrEqual(header - 8);
      }
    } else {
      expect(place.squeeze).toBe(0);
      if (place.over > 0) IMPOSSIBLE[name] = [m.viewportH - m.regionBottom - m.topLine, 0, 89 + 20];
    }
  });

  it('lists the physically impossible cells, each short of room even with the log at its floor', () => {
    // [room, the log's give, needed]: room + give < needed in every one.
    // The offline banner wraps to two lines at 420 wide: 78 px to the log's
    // line, 89 more from the log at its floor, and the card's header, one
    // line and footer with the "more" row and the newest notice need 203.
    expect(IMPOSSIBLE).toEqual({
      '420x560 open 2 banner': [78, 89, 203],
      '420x560 open 3 banner': [78, 89, 203],
      '420x560 open 4 banner': [78, 89, 203],
    });
    for (const [room, give, need] of Object.values(IMPOSSIBLE)) expect(room + give).toBeLessThan(need);
  });

  it('lists the cells where the body goes under its kept lines', () => {
    // The docked open log: only with the log at its floor (asserted per cell).
    expect(UNDER_FADE.filter((name) => name.includes(' open '))).toEqual([
      '420x560 open 0 banner',
      '420x560 open 1 banner',
      '420x560 open 2',
      '420x560 open 2 banner',
      '420x560 open 3',
      '420x560 open 3 banner',
      '420x560 open 4',
      '420x560 open 4 banner',
      '420x640 open 2 banner',
      '420x640 open 3 banner',
      '420x640 open 4 banner',
      '768x600 open 1 banner',
      '768x600 open 2',
      '768x600 open 2 banner',
      '768x600 open 3',
      '768x600 open 3 banner',
      '768x600 open 4',
      '768x600 open 4 banner',
    ]);
    // A closed log gives nothing: the 420x560 window under the two-line banner.
    expect(UNDER_FADE.filter((name) => name.includes(' closed '))).toEqual([
      '420x560 closed 2 banner',
      '420x560 closed 3 banner',
      '420x560 closed 4 banner',
    ]);
    // A floating log is round 3c's, unchanged: the card takes the larger side
    // (or goes under the log) at the heights where neither side holds it.
    expect(UNDER_FADE.filter((name) => name.includes(' floating '))).toEqual([
      '420x560 floating 0',
      '420x560 floating 0 banner',
      '420x560 floating 1',
      '420x560 floating 1 banner',
      '420x560 floating 2',
      '420x560 floating 2 banner',
      '420x560 floating 3',
      '420x560 floating 3 banner',
      '420x560 floating 4',
      '420x560 floating 4 banner',
      '420x640 floating 0',
      '420x640 floating 0 banner',
      '420x640 floating 1',
      '420x640 floating 1 banner',
      '420x640 floating 2',
      '420x640 floating 2 banner',
      '420x640 floating 3',
      '420x640 floating 3 banner',
      '420x640 floating 4',
      '420x640 floating 4 banner',
      '420x760 floating 2',
      '420x760 floating 2 banner',
      '420x760 floating 3',
      '420x760 floating 3 banner',
      '420x760 floating 4',
      '420x760 floating 4 banner',
      '768x600 floating 0',
      '768x600 floating 0 banner',
      '768x600 floating 1',
      '768x600 floating 1 banner',
      '768x600 floating 2',
      '768x600 floating 2 banner',
      '768x600 floating 3',
      '768x600 floating 3 banner',
      '768x600 floating 4',
      '768x600 floating 4 banner',
      '1024x640 floating 0',
      '1024x640 floating 0 banner',
      '1024x640 floating 1',
      '1024x640 floating 1 banner',
      '1024x640 floating 2',
      '1024x640 floating 2 banner',
      '1024x640 floating 3',
      '1024x640 floating 3 banner',
      '1024x640 floating 4',
      '1024x640 floating 4 banner',
    ]);
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
    aboveLog: true, lift: 188, cap: 154, mode: 'under', folded: 0, more: 0, expanded: false, keepPlan: false, squeeze: 0, underFade: false, over: 0, ...over,
  });

  it('folds the older notices, names the row and its state, and marks the step', () => {
    const { region, stack, more, toasts } = stackDom(3);
    applyNoticeStack(region, stack, place({ mode: 'folded', folded: 2, more: 2 }));
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
    applyNoticeStack(region, stack, place({ mode: 'folded', folded: 2, more: 2 }));
    expect(more.textContent).toBe('2 more notices');
    applyNoticeStack(region, stack, place({ mode: 'under' }));
    expect(region.hasAttribute(MORE_SHOWN_ATTR)).toBe(false);
    expect(more.hidden).toBe(true);
    expect(region.dataset.noticeMode).toBe('under');
    // An inert of the notice's own is not the fold's to take away.
    toasts[2].setAttribute('inert', '');
    applyNoticeStack(region, stack, place({ mode: 'under' }));
    expect(toasts[2].hasAttribute('inert')).toBe(true);
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
      ['card', [{ transform: 'translateY(-100px)' }, { transform: 'translateY(0)' }]],
      ['toast t0', [{ transform: 'translateY(178px)' }, { transform: 'translateY(0)' }]],
      ['toast t1', [{ transform: 'translateY(184px)' }, { transform: 'translateY(0)' }]],
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
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ top: 104, bottom: 248, height: 144 } as DOMRect);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ transform: 'matrix(0.96, 0, 0, 0.96, 0, -30)' } as CSSStyleDeclaration);
    // 150 tall at 0.96 about its centre, 30 px up: it rests at 131-281.
    expect(layoutBox(card)).toEqual({ top: 131, bottom: 281, height: 150 });
    vi.mocked(window.getComputedStyle).mockReturnValue({ transform: 'none' } as CSSStyleDeclaration);
    expect(layoutBox(card)).toEqual({ top: 104, bottom: 248, height: 144 });
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
    document.body.innerHTML = `
      <div data-notice-region=""><div class="notice-region__stack">
        <div data-notice-slot="proposal"><div class="card" data-notice-shrinks="">
          <div class="head"></div><div class="scroll" data-notice-shrink-body=""><div class="body"><p class="plan" data-notice-keep=""></p><ul><li class="warn" data-notice-keep=""></li></ul></div></div>
          <div class="foot" data-notice-shrink-foot=""></div>
        </div></div>
        <div data-notice-slot="canvas"><div class="toast"></div></div>
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
    expect(m).toMatchObject({ regionLeft: 70, regionBottom: 80, logClearance: 348, logTop: 206, topLine: 72, logSpare: 198 - 91 });
    // The kept lines: the plan line's top to the first ⚠ row's foot.
    expect(m.card).toMatchObject({ chrome: 100, body: 700, foot: 54, items: [46], plan: { top: 77, bottom: 142 } });
    applyNoticeStack(region, stack, placeNoticeStack(m));
    expect(region.dataset.aboveLog).toBe('true');
    expect(region.dataset.noticeMode).toBe('under');
    expect(region.style.getPropertyValue('--notice-stack-lift')).toBe('126px');
    expect(document.querySelector<HTMLElement>('.card')!.style.getPropertyValue('--notice-card-cap'))
      .toBe(`${900 - 80 - 126 - 54 - 72}px`);
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
    expect(rule(REGION_CSS, ".notice-region:is([data-notice-mode='above'], [data-notice-mode='folded']) .notice-region__slot > [data-notice-shrinks]").order).toBe('1');
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
