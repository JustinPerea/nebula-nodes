import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CLIP_ATTR,
  CLIPPED_ROW_PX,
  FLOAT_GAP_PX,
  STACK_CAP_ATTR,
  applyNoticeStack,
  measureNoticeStack,
  placeNoticeStack,
  rowHeight,
  stackGeometry,
  stackLimit,
  snapTight,
  stepChanged,
  tightFloor,
  type StackMeasure,
  type StackPlace,
} from '../src/lib/noticeStackPlace';

/**
 * PR #216 round 3m, GM - Design r76.
 * 1. Undo notices never fold; they follow the card's place (under the
 *    banner; under a floating log into its body, never its header). When at
 *    their full height that leaves the card short of its footer (Accept,
 *    Reject), each keeps its line and buttons and cuts its text with "…"
 *    (`clip`), its full text in its aria-label. Past even that (a window
 *    far shorter than the app's), the stack caps at its room and scrolls.
 * 2. Docked: the card's foot never comes down over the docked log's header
 *    (r6 step 5 amended); the card caps and scrolls, Accept/Reject pinned.
 *
 * The card is the live one (round 3h: header and footer 89, its footer 54,
 * the plan line 77-110, the first ⚠ row's foot at 142 in a 198 px body), the
 * region's line 81 px over the window's foot, the offline banner's line 199
 * at 800x420 (round 3l live: the banner 150-183 and the 16 px gutter). An
 * Undo notice is 46 tall on one line of text (2-line text: 62), 42 kept to
 * one line (its 28 px buttons, live).
 */
const CARD = { chrome: 89, body: 198, foot: 54, line: 20, gap: 8, plan: { top: 77, bottom: 142 }, first: { top: 77, bottom: 110 } };
const HEADER = 44;
const BASE: StackMeasure = {
  viewportW: 800, viewportH: 420, gutter: 16, regionLeft: 64, regionBottom: 81,
  logClearance: 0, logTop: 0, topLine: 199, logSpare: 0, logCollapse: 0, logHeader: HEADER,
  card: { ...CARD, items: [] }, column: { left: 125, right: 725 }, floating: null,
};
const cell = (over: Partial<StackMeasure>): StackMeasure => ({ ...BASE, ...over });
const withNotices = (items: number[], undo: boolean[], over: Partial<StackMeasure> = {}) => cell({
  ...over, card: { ...CARD, items, undo, host: undo, clipped: items.map((h, i) => (undo[i] ? CLIPPED_ROW_PX : h)) },
});

/** Every box the stack draws (a capped stack's scrolled-out part drawn nowhere). */
function drawn(m: StackMeasure, place: StackPlace) {
  const geo = stackGeometry(m, place);
  const from = place.stackCap !== null && place.stackCap !== undefined ? geo.line - place.stackCap : Number.NEGATIVE_INFINITY;
  const all = [{ ...geo.card!, kind: 'card' as const }, ...geo.rows];
  return { geo, from, boxes: all.map((box) => ({ ...box, top: Math.max(box.top, from) })).filter((box) => box.bottom > box.top) };
}

/** GM r69 Q1 and r76: nothing at rest over the banner, a floating log's header, or a docked log. */
function clearOfEverything(m: StackMeasure, place: StackPlace) {
  const { boxes, geo } = drawn(m, place);
  const give = place.squeeze + (place.collapse ? m.logCollapse ?? 0 : 0);
  for (const box of boxes) {
    expect(box.top).toBeGreaterThanOrEqual(m.topLine - 0.5);
    expect(box.bottom).toBeLessThanOrEqual(m.viewportH - m.regionBottom + 0.5);
    if (m.floating && (place.float === 'under' || place.float === 'above')) {
      const top = m.floating.top + (place.hold === 'bottom' ? give : 0);
      expect(box.bottom <= top + 0.5 || box.top >= top + HEADER - 0.5).toBe(true);
    }
    // The docked log (its header is its top, come down by its give).
    if (place.aboveLog) expect(box.bottom).toBeLessThanOrEqual(m.viewportH - m.logTop + give + 0.5);
  }
  // The stack's line and what its place may use.
  expect(geo.line - (place.stackCap ?? 0)).toBeGreaterThanOrEqual(stackLimit(m, place) - 0.5);
}

describe('GM r76 1: Undo notices follow the card, kept to one line when they must be', () => {
  it('room for them whole: nothing is kept to one line', () => {
    const m = withNotices([46, 46], [false, true], { topLine: 72 });
    const place = placeNoticeStack(m);
    expect(place.clip ?? []).not.toContain(true);
    clearOfEverything(m, place);
  });

  it('round 3l\'s live cell (800x420, a collapsed log at 250-294, a message and "Moved “Hero shot”. Undo"): nothing over the banner', () => {
    // 3l: the Undo notice stood over the banner here. Above the log 43 px
    // (199 to 242), under it 37, no body to stand in: not even the footer
    // fits, so the stack caps at 43 and scrolls, the card in view at its
    // foot, the Undo notice (on one line) over it in the scroll.
    const m = withNotices([46, 62], [false, true], { floating: { top: 250, bottom: 294, left: 200, right: 540 } });
    const place = placeNoticeStack(m);
    // The message folds (the pill); the Undo notice never does.
    expect(place.fold).toEqual([true, false]);
    expect(place).toMatchObject({ clip: [false, true], float: 'above', stackCap: 250 - FLOAT_GAP_PX - 199, cap: 43, tight: true });
    clearOfEverything(m, place);
    const { geo } = drawn(m, place);
    const undoRow = geo.rows.find((row) => row.kind === 'notice')!;
    expect(undoRow.bottom - undoRow.top).toBe(CLIPPED_ROW_PX);
    // Room for the footer, its header line and the Undo notice on one line (a banner 89 px higher): both whole, no scroll.
    const roomy = { ...m, topLine: 110 };
    const roomyPlace = placeNoticeStack(roomy);
    expect(roomyPlace.stackCap ?? null).toBeNull();
    clearOfEverything(roomy, roomyPlace);
    const roomyGeo = stackGeometry(roomy, roomyPlace);
    expect(roomyGeo.card!.bottom - roomyGeo.card!.top).toBeGreaterThanOrEqual(CARD.foot);
    expect(roomyGeo.rows.every((row) => row.top >= 110)).toBe(true);
    expect(roomyPlace.clip).toEqual([false, true]);
  });

  it('an Undo notice already on one line is never "clipped" (nothing to cut)', () => {
    const m = withNotices([42], [true], { floating: { top: 250, bottom: 294, left: 200, right: 540 } });
    expect(placeNoticeStack(m).clip ?? []).not.toContain(true);
  });

  it('a notice with no Undo is never kept to one line (it folds instead)', () => {
    const m = withNotices([62, 62], [false, false], { floating: { top: 250, bottom: 294, left: 200, right: 540 } });
    expect(placeNoticeStack(m).clip ?? []).not.toContain(true);
    // Unmeasured one-line heights (CLIPPED_ROW_PX for each): only the Undo notice is cut.
    const mixed = cell({ card: { ...CARD, items: [62, 62], undo: [false, true], host: [false, true] } });
    expect(placeNoticeStack({ ...mixed, topLine: 230 }).clip).toEqual([false, true]);
  });

  it('the row drawn on one line uses its measured height, else CLIPPED_ROW_PX', () => {
    const card = { ...CARD, items: [62, 46], undo: [true, false], clipped: [40, 46] };
    expect(rowHeight(card, 0, [true, false])).toBe(40);
    expect(rowHeight(card, 0, [false, false])).toBe(62);
    expect(rowHeight({ ...card, clipped: undefined }, 0, [true])).toBe(CLIPPED_ROW_PX);
    // Never taller than it is.
    expect(rowHeight({ ...CARD, items: [30], clipped: undefined }, 0, [true])).toBe(30);
  });

  it('under a floating log, the Undo notices may stand in its body, never its header', () => {
    // A tall open log the person reopened (no collapse), the card under it in the shortfall.
    const m = withNotices([62, 62], [true, true], {
      viewportH: 520, topLine: 120, logSpare: 0, logCollapse: 0,
      floating: { top: 140, bottom: 380, left: 200, right: 540 },
    });
    const place = placeNoticeStack(m);
    clearOfEverything(m, place);
    for (const box of drawn(m, place).boxes) expect(box.top).toBeGreaterThanOrEqual(140 + HEADER + FLOAT_GAP_PX - 0.5);
  });

  it('past even one line each: the stack caps at its room and scrolls, the card keeping its footer', () => {
    // Three Undo notices on one line (150 with gaps) and the footer (54) in 140.
    const m = withNotices([62, 62, 62], [true, true, true], { topLine: 199 });
    const place = placeNoticeStack(m);
    expect(place.clip).toEqual([true, true, true]);
    expect(place.stackCap).toBe(420 - 81 - 199);
    // Its footer (the rows leave less than that).
    expect(place.cap).toBe(CARD.foot);
    expect(place.tight).toBe(true);
    clearOfEverything(m, place);
    // The Undo notices never fold.
    expect(place.fold).toEqual([false, false, false]);
  });

  it('the card\'s floor beside them: its footer and its header\'s line; with less, its footer alone, no line cut', () => {
    expect(tightFloor(CARD)).toBe(CARD.foot + CARD.line);
    expect(snapTight(CARD, 60)).toBe(CARD.foot);
    expect(snapTight(CARD, CARD.foot + CARD.line)).toBe(CARD.foot + CARD.line);
    expect(snapTight(CARD, 40)).toBe(40);
    // No notices: no room for the floor (none 60 px under the banner): the footer alone.
    const bare = cell({ topLine: 420 - 81 - 60 });
    expect(placeNoticeStack(bare)).toMatchObject({ cap: CARD.foot, tight: true });
    // One Undo notice on one line (42 + 8) and 60 px left: the footer alone, nothing scrolls.
    const one = withNotices([62], [true], { topLine: 420 - 81 - 110 });
    const place = placeNoticeStack(one);
    expect(place).toMatchObject({ clip: [true], cap: CARD.foot, stackCap: null });
    clearOfEverything(one, place);
  });

  it('a seeded sweep of short windows with the banner, Undo notices among the rows, floating, docked and no log: nothing at rest over the banner, a log\'s header or a docked log', () => {
    let seed = 216_13;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
    const seen = { floating: 0, docked: 0, none: 0, clipped: 0, scrolled: 0 };
    for (let i = 0; i < 6000; i += 1) {
      const viewportH = 360 + Math.floor(rand() * 340);
      const viewportW = pick([784, 800, 1024, 1280]);
      const topLine = 16 + Math.floor(rand() * Math.max(1, viewportH / 2));
      const where = pick(['floating', 'floating', 'docked', 'none'] as const);
      const kind = pick(['open', 'reopened', 'collapsed'] as const);
      const count = Math.floor(rand() * 4);
      const undo = Array.from({ length: count }, () => rand() < 0.6);
      const items = undo.map((u) => (u && rand() < 0.5 ? 62 : 46));
      const m0 = withNotices(items, undo, {
        viewportW, viewportH, topLine, column: { left: (viewportW - 600) / 2, right: (viewportW + 600) / 2 },
      });
      let m: StackMeasure;
      if (where === 'floating') {
        const want = kind === 'collapsed' ? HEADER : 100 + Math.floor(rand() * 200);
        const top = Math.floor(rand() * (viewportH - 81 - HEADER));
        // The log's header itself under the banner's line: the person put it there.
        if (top < topLine) continue;
        const height = Math.min(want, viewportH - 81 - top);
        const left = 80 + Math.floor(rand() * (viewportW - 500));
        const floor = Math.min(height, 91);
        m = { ...m0, logSpare: kind === 'collapsed' ? 0 : height - floor, logCollapse: kind === 'open' ? floor - HEADER : 0, floating: { top, bottom: top + height, left, right: left + 400 } };
      } else if (where === 'docked') {
        // Docked at the region's line, 348 wide plus its gap: --agent-log-top
        // is its natural top plus the gap, over the window's foot.
        const height = kind === 'collapsed' ? HEADER : 100 + Math.floor(rand() * 200);
        const logTop = 81 + height + 8;
        if (viewportH - logTop < topLine) continue;
        const floor = Math.min(height, 91);
        m = { ...m0, logClearance: 356, logTop, logSpare: kind === 'collapsed' ? 0 : height - floor, logCollapse: kind === 'open' ? floor - HEADER : 0 };
      } else m = m0;
      const place = placeNoticeStack(m);
      clearOfEverything(m, place);
      // Undo notices never fold; a notice with no Undo is never cut.
      undo.forEach((u, index) => {
        if (u) expect(place.fold[index]).toBe(false);
        else expect(place.clip?.[index] ?? false).toBe(false);
      });
      // Accept and Reject in view whenever the room holds them.
      const { geo } = drawn(m, place);
      const room = geo.line - stackLimit(m, place);
      expect(geo.card!.bottom - geo.card!.top).toBeGreaterThanOrEqual(Math.min(CARD.foot, room) - 0.5);
      seen[where] += 1;
      if (place.clip?.some(Boolean)) seen.clipped += 1;
      if (place.stackCap !== null && place.stackCap !== undefined) seen.scrolled += 1;
    }
    expect(seen.floating).toBeGreaterThan(1500);
    expect(seen.docked).toBeGreaterThan(800);
    expect(seen.none).toBeGreaterThan(1000);
    expect(seen.clipped).toBeGreaterThan(100);
    expect(seen.scrolled).toBeGreaterThan(10);
  });
});

describe('GM r76 2: docked at 800x420, the card\'s foot never comes over the log', () => {
  // Round 3l's live cell: the docked log 444-784 (its clearance 356 with the
  // gap), its natural height 180 (header 44, floor 91), so --agent-log-top
  // 268; the banner's line 199.
  const docked = (over: Partial<StackMeasure> = {}) => cell({
    logClearance: 356, logTop: 268, logSpare: 180 - 91, logCollapse: 91 - HEADER, ...over,
  });

  it('the log gives all it can (body, then its header alone), and the card caps above its line, scrolling, Accept/Reject pinned', () => {
    const m = docked();
    const place = placeNoticeStack(m);
    expect(place).toMatchObject({ aboveLog: true, collapse: true, squeeze: 180 - 91, over: 0 });
    const { geo } = drawn(m, place);
    // The log's header, come down to 420 - 81 - 44 = 295; the stack's line 8 over it.
    const header = 420 - 268 + 8 + (180 - HEADER);
    expect(header).toBe(296);
    expect(geo.line).toBe(header - 8);
    expect(geo.card!.bottom).toBe(288);
    expect(geo.card!.top).toBe(199);
    // 89 tall: header and footer, no whole line of body, so it scrolls whole.
    expect(place.tight).toBe(true);
    clearOfEverything(m, place);
  });

  it('round 3l had its foot 24 px over the log\'s header there; never again, with notices too', () => {
    for (const [items, undo] of [[[46], [true]], [[62, 46], [true, false]], [[62, 62], [true, true]]] as const) {
      const m = cell({
        logClearance: 356, logTop: 268, logSpare: 180 - 91, logCollapse: 91 - HEADER,
        card: { ...CARD, items: [...items], undo: [...undo], host: [...undo], clipped: items.map((h, i) => (undo[i] ? CLIPPED_ROW_PX : h)) },
      });
      const place = placeNoticeStack(m);
      expect(place.over).toBe(0);
      clearOfEverything(m, place);
      const { geo } = drawn(m, place);
      expect(geo.card!.bottom - geo.card!.top).toBeGreaterThanOrEqual(CARD.foot);
    }
  });
});

describe('GM r76: the clip on the page', () => {
  const page = () => {
    document.body.innerHTML = `
      <div data-notice-region=""><div class="notice-region__stack">
        <div data-notice-slot="a"><div class="canvas-undo-notice" role="status"><span class="canvas-undo-notice__text">Moved “Hero shot” and 4 more nodes to the right of the brief.</span><button>Undo</button><button aria-label="Dismiss">×</button></div></div>
        <div data-notice-slot="proposal"><div class="card" data-notice-shrinks="">
          <div class="head"></div><div class="scroll" data-notice-shrink-body=""></div><div class="foot" data-notice-shrink-foot=""></div>
        </div></div>
      </div></div>`;
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    const stack = region.querySelector<HTMLElement>('.notice-region__stack')!;
    const notice = stack.querySelector<HTMLElement>('.canvas-undo-notice')!;
    return { region, stack, notice };
  };
  const base = (over: Partial<StackPlace> = {}): StackPlace => ({
    aboveLog: false, lift: 0, cap: 120, mode: 'above', folded: 0, fold: [false], more: 0, moreHost: -1, expanded: false,
    keepPlan: false, squeeze: 0, collapse: false, underFade: false, over: 0, ...over,
  });

  it('marks the notice, names it with its full text, and lifts both when it has room again', () => {
    const { region, stack, notice } = page();
    applyNoticeStack(region, stack, base({ clip: [true] }));
    expect(notice.hasAttribute(CLIP_ATTR)).toBe(true);
    expect(notice.getAttribute('aria-label')).toBe('Moved “Hero shot” and 4 more nodes to the right of the brief.');
    applyNoticeStack(region, stack, base());
    expect(notice.hasAttribute(CLIP_ATTR)).toBe(false);
    expect(notice.hasAttribute('aria-label')).toBe(false);
    document.body.innerHTML = '';
  });

  it('never replaces or lifts a label the notice had of its own', () => {
    const { region, stack, notice } = page();
    notice.setAttribute('aria-label', 'Own name');
    applyNoticeStack(region, stack, base({ clip: [true] }));
    expect(notice.hasAttribute(CLIP_ATTR)).toBe(true);
    expect(notice.getAttribute('aria-label')).toBe('Own name');
    applyNoticeStack(region, stack, base());
    expect(notice.hasAttribute(CLIP_ATTR)).toBe(false);
    expect(notice.getAttribute('aria-label')).toBe('Own name');
    document.body.innerHTML = '';
  });

  it('the measure reads a clipped notice at its full height, and an Undo notice on one line, and leaves each as it was', () => {
    const { region, stack, notice } = page();
    notice.setAttribute(CLIP_ATTR, '');
    const spy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this === notice) return this.hasAttribute(CLIP_ATTR) ? 42 : 62;
      return this.classList.contains('card') ? 200 : 0;
    });
    const m = measureNoticeStack(region, stack, 199);
    expect(m.card!.items).toEqual([62]);
    expect(m.card!.clipped).toEqual([42]);
    expect(m.card!.undo).toEqual([true]);
    expect(notice.hasAttribute(CLIP_ATTR)).toBe(true);
    notice.removeAttribute(CLIP_ATTR);
    measureNoticeStack(region, stack, 199);
    expect(notice.hasAttribute(CLIP_ATTR)).toBe(false);
    spy.mockRestore();
    document.body.innerHTML = '';
  });

  it('a capped stack with the card in it is scrolled to its foot (the card\'s footer in view)', () => {
    const { region, stack } = page();
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this === stack ? 250 : 0; }),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this === stack ? 140 : 0; }),
    ];
    applyNoticeStack(region, stack, base({ clip: [true], stackCap: 140, cap: 54, tight: true }));
    expect(region.hasAttribute(STACK_CAP_ATTR)).toBe(true);
    expect(stack.scrollTop).toBe(110);
    spies.forEach((spy) => spy.mockRestore());
    applyNoticeStack(region, stack, base());
    expect(region.hasAttribute(STACK_CAP_ATTR)).toBe(false);
    document.body.innerHTML = '';
  });

  it('a clip coming or going is a step: it glides', () => {
    expect(stepChanged(base(), base({ clip: [true] }))).toBe(true);
    expect(stepChanged(base({ clip: [false] }), base())).toBe(false);
    expect(stepChanged(base({ clip: [true] }), base({ clip: [true] }))).toBe(false);
  });

  it('the cut is CSS: one line with "…" on a clipped notice\'s text, held to its slot', () => {
    const css = readFileSync(join(__dirname, '../src/styles/canvasProposals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.canvas-undo-notice\[data-notice-clipped\] \.canvas-undo-notice__text \{\s*overflow: hidden;\s*white-space: nowrap;\s*text-overflow: ellipsis;/);
    expect(css).toMatch(/\.canvas-undo-notice\[data-notice-clipped\] \{\s*max-width: min\(var\(--notice-max-w, 560px\), 100%\);/);
  });
});
