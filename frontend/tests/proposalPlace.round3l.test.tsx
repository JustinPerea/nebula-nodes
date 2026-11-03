import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FLOAT_GAP_PX,
  MORE_ROW_PX,
  MORE_SLOT_ATTR,
  STACK_CAP_ATTR,
  TIGHT_ATTR,
  applyNoticeStack,
  glideStack,
  measureNoticeStack,
  placeNoticeStack,
  stackGeometry,
  type StackMeasure,
  type StackPlace,
} from '../src/lib/noticeStackPlace';

/**
 * PR #216 round 3l: GM r69 Q1 and Q4 in the placement, and review 4's
 * surviving mutants pinned (logic NIT-1).
 *
 * The card is the live one (round 3h, 340 px: header and footer 89, the plan
 * line 77-110 and the first ⚠ row's foot at 142 in a 198 px body), notices 46
 * tall with 8 px gaps, the region's line 81 px over the window's foot.
 */
const CARD = { chrome: 89, body: 198, foot: 54, line: 20, gap: 8, plan: { top: 77, bottom: 142 }, first: { top: 77, bottom: 110 } };
const HEADER = 44;
const BASE: StackMeasure = {
  viewportW: 800, viewportH: 420, gutter: 16, regionLeft: 64, regionBottom: 81,
  logClearance: 0, logTop: 0, topLine: 150, logSpare: 0, logCollapse: 0, logHeader: HEADER,
  card: { ...CARD, items: [] }, column: { left: 100, right: 700 }, floating: null,
};
const cell = (over: Partial<StackMeasure>): StackMeasure => ({ ...BASE, ...over });

/** Every box the stack draws, and the invariants GM r69 Q1 holds at rest. */
function boxes(m: StackMeasure, place: StackPlace) {
  const geo = stackGeometry(m, place);
  return [geo.card!, ...geo.rows];
}
function clearOfBannerAndHeader(m: StackMeasure, place: StackPlace) {
  for (const box of boxes(m, place)) {
    // Never over the offline banner (its line is the top line).
    expect(box.top).toBeGreaterThanOrEqual(m.topLine);
    expect(box.bottom).toBeLessThanOrEqual(m.viewportH - m.regionBottom);
    // Never over the log's header (its expand control), where it is once it
    // gives: held at its bottom edge (the card above it), its top comes down.
    if (m.floating && (place.float === 'under' || place.float === 'above')) {
      const give = place.squeeze + (place.collapse ? m.logCollapse ?? 0 : 0);
      const top = m.floating.top + (place.hold === 'bottom' ? give : 0);
      expect(box.bottom <= top || box.top >= top + (m.logHeader ?? HEADER)).toBe(true);
    }
  }
}

describe('GM r69 Q1: the card never covers the offline banner', () => {
  it('review 4 logic LOW-2\'s cell (784x431, banner line 199, a collapsed log at 190-234): under the log, not above it over the banner', () => {
    const m = cell({ viewportW: 784, viewportH: 431, topLine: 199, column: { left: 92, right: 692 }, floating: { top: 190, bottom: 234, left: 92, right: 692 } });
    const place = placeNoticeStack(m);
    expect(place).toMatchObject({ float: 'under', tight: false });
    const { card } = stackGeometry(m, place);
    // 242-350: its header and footer whole, 19 px of body.
    expect([card!.top, card!.bottom]).toEqual([234 + FLOAT_GAP_PX, 431 - 81]);
    clearOfBannerAndHeader(m, place);
  });

  it('above while its header and footer fit under the banner and under-crossing holds no line (review 3 LOW-1\'s cell, r57)', () => {
    const m = cell({
      viewportW: 1024, viewportH: 640, topLine: 199, column: { left: 212, right: 812 }, floating: { top: 357, bottom: 401, left: 212, right: 812 },
      card: { ...CARD, items: [46, 46], undo: [false, true], host: [false, true] },
    });
    const place = placeNoticeStack(m);
    expect(place.float).toBe('above');
    clearOfBannerAndHeader(m, place);
    // The banner one line lower: above no longer fits its header and footer, so under.
    const low = { ...m, topLine: 357 - FLOAT_GAP_PX - CARD.chrome + 1 };
    const lowPlace = placeNoticeStack(low);
    expect(lowPlace.float).toBe('under');
    clearOfBannerAndHeader(low, lowPlace);
  });

  describe('800x420 with the banner', () => {
    // The open floating log in the card's column, at several heights; with
    // and without notices; may collapse or not (the person reopened it).
    const tops = [150, 160, 180, 200, 220, 240, 260, 280, 300];
    for (const top of tops) {
      for (const [name, spare, collapse] of [['open', 63, 47], ['reopened', 63, 0], ['collapsed', 0, 0]] as const) {
        for (const items of [[], [46], [46, 46]]) {
          it(`log at ${top}, ${name}, ${items.length} notices: clear of the banner and the log's header at rest`, () => {
            const height = name === 'collapsed' ? HEADER : 154;
            const m = cell({
              logSpare: spare, logCollapse: collapse,
              card: { ...CARD, items, undo: items.map(() => false) },
              floating: { top, bottom: Math.min(339, top + height), left: 100, right: 700 },
            });
            const place = placeNoticeStack(m);
            clearOfBannerAndHeader(m, place);
            // Capped under its own header and footer only when nothing else fits.
            if (place.tight) expect(place.cap!).toBeLessThan(CARD.chrome);
          });
        }
      }
    }

    it('no room between the banner and the bottom edge for its header and footer: capped there, scrolling, Accept/Reject pinned', () => {
      // A tall banner (line 220), a collapsed log at 230-274: above it 2 px,
      // under it 57; nothing to cross.
      const m = cell({ topLine: 220, floating: { top: 230, bottom: 274, left: 100, right: 700 } });
      const place = placeNoticeStack(m);
      expect(place).toMatchObject({ float: 'under', tight: true, cap: 339 - 282 });
      clearOfBannerAndHeader(m, place);
      // With no log at all, a banner over most of the window: the same cap.
      const none = cell({ topLine: 300, floating: null });
      const nonePlace = placeNoticeStack(none);
      expect(nonePlace).toMatchObject({ tight: true, cap: 339 - 300 });
      clearOfBannerAndHeader(none, nonePlace);
      // A docked log under it: the card comes down over the log's top edge
      // first (step 5), then caps under the banner.
      const docked = cell({ topLine: 300, logClearance: 360, logTop: 200, floating: null, viewportW: 800 });
      const dockedPlace = placeNoticeStack(docked);
      expect(dockedPlace.tight).toBe(true);
      for (const box of boxes(docked, dockedPlace)) expect(box.top).toBeGreaterThanOrEqual(300);
    });
  });

  it('a seeded sweep of short windows with the banner: nothing at rest over the banner or a floating log\'s header', () => {
    let seed = 216_3;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
    let checked = 0;
    for (let i = 0; i < 4000; i += 1) {
      const viewportH = 360 + Math.floor(rand() * 340);
      const viewportW = pick([784, 800, 1024, 1280]);
      const topLine = 16 + Math.floor(rand() * Math.max(1, viewportH / 2));
      const kind = pick(['open', 'reopened', 'collapsed'] as const);
      const want = kind === 'collapsed' ? HEADER : 100 + Math.floor(rand() * 200);
      const top = Math.floor(rand() * (viewportH - 81 - HEADER));
      const height = Math.min(want, viewportH - 81 - top);
      const left = 80 + Math.floor(rand() * (viewportW - 500));
      const count = Math.floor(rand() * 3);
      const undo = Array.from({ length: count }, () => rand() < 0.3);
      // Its give as AgentLog writes it: down to its floor of header and 2
      // rows (91), then (while it may collapse) to its header.
      const floor = Math.min(height, 91);
      const spare = kind === 'collapsed' ? 0 : height - floor;
      const m = cell({
        viewportW, viewportH, topLine, logSpare: spare, logCollapse: kind === 'open' ? floor - HEADER : 0,
        card: { ...CARD, items: undo.map(() => 46), undo, host: undo },
        column: { left: (viewportW - 600) / 2, right: (viewportW + 600) / 2 },
        floating: { top, bottom: top + height, left, right: left + 400 },
      });
      // The log's header itself under the banner's line: the person put it there.
      if (top < topLine) continue;
      // Notices that never fold (Undo) with no room for them and the card's
      // footer on either side: out of this rule's reach (see the notes).
      const rows = undo.reduce((total, u) => total + (u ? 54 : 0), 0) + (undo.some((u) => !u) ? MORE_ROW_PX + 8 : 0);
      const line0 = viewportH - 81;
      const room = Math.max(top - FLOAT_GAP_PX - topLine, line0 - Math.max(topLine, top + HEADER + FLOAT_GAP_PX));
      if (rows + CARD.foot > room) continue;
      const place = placeNoticeStack(m);
      clearOfBannerAndHeader(m, place);
      // Capped, Accept and Reject (its footer) still in view.
      if (place.tight) expect(place.cap!).toBeGreaterThanOrEqual(CARD.foot);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('writes the cap\'s mark on the card, and the card scrolls as a whole with its footer pinned (noticeRegion.css)', () => {
    document.body.innerHTML = `
      <div data-notice-region=""><div class="notice-region__stack">
        <button data-notice-more=""></button>
        <div data-notice-slot="proposal"><div class="card" data-notice-shrinks="">
          <div class="head"></div><div class="scroll" data-notice-shrink-body=""></div><div class="foot" data-notice-shrink-foot=""></div>
        </div></div>
      </div></div>`;
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    const stack = region.querySelector<HTMLElement>('.notice-region__stack')!;
    const card = stack.querySelector<HTMLElement>('.card')!;
    const tight = placeNoticeStack(cell({ topLine: 300 }));
    applyNoticeStack(region, stack, tight);
    expect(card.hasAttribute(TIGHT_ATTR)).toBe(true);
    expect(card.style.getPropertyValue('--notice-card-cap')).toBe('39px');
    // Scrolled so the header's line sits whole above the pinned footer: a
    // 39 px card, its header 34 (14 + its 20 px line), its footer 54.
    const head = card.querySelector<HTMLElement>('.head')!;
    const foot = card.querySelector<HTMLElement>('.foot')!;
    head.setAttribute('data-notice-shrink-head', '');
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) { return this === foot ? 38 : 0; }),
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this === head ? 34 : this === foot ? 54 : 0; }),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this === card ? 75 : 0; }),
    ];
    applyNoticeStack(region, stack, tight);
    expect(card.scrollTop).toBe(34 - (75 - 54));
    spies.forEach((spy) => spy.mockRestore());
    applyNoticeStack(region, stack, placeNoticeStack(cell({ topLine: 16 })));
    expect(card.hasAttribute(TIGHT_ATTR)).toBe(false);
    expect(card.scrollTop).toBe(0);
    document.body.innerHTML = '';
    const css = readFileSync(join(__dirname, '../src/styles/noticeRegion.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.notice-region__slot > \[data-notice-shrinks\]\[data-notice-tight\] \{\s*overflow-y: auto;/);
    expect(css).toMatch(/\.notice-region__slot > \[data-notice-shrinks\]\[data-notice-tight\] > \[data-notice-shrink-foot\] \{\s*position: sticky;\s*bottom: 0;/);
    const cards = readFileSync(join(__dirname, '../src/styles/canvasProposals.css'), 'utf8');
    // Opaque: the card's glass over the canvas colour.
    expect(cards).toMatch(/--notice-tight-foot-fill: linear-gradient\(var\(--sr-glass-strong[^;]*\), var\(--sr-canvas, #000\);/);
  });

  it('a capped card\'s measure counts what it hides, so the cap never feeds back smaller', () => {
    document.body.innerHTML = `
      <div data-notice-region=""><div class="notice-region__stack">
        <div data-notice-slot="proposal"><div class="card" data-notice-shrinks="">
          <div class="head"></div><div class="scroll" data-notice-shrink-body=""></div><div class="foot" data-notice-shrink-foot=""></div>
        </div></div>
      </div></div>`;
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    const stack = region.querySelector<HTMLElement>('.notice-region__stack')!;
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('card') ? 57 : 0; }),
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('card') ? 92 : 0; }),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('card') ? 55 : 0; }),
    ];
    // 57 tall (2 of it borders), its rows 92: the header and footer are 89 + 2 + 0 of body.
    expect(measureNoticeStack(region, stack, 220).card!.chrome).toBe(57 + 92 - 55);
    spies.forEach((spy) => spy.mockRestore());
    document.body.innerHTML = '';
  });
});

describe('GM r69 Q4: with no card, the expanded stack caps to the side with more room and scrolls', () => {
  // Review 4 layout LOW-2's cell: 1280x560, a 600 px log at 340-940 x 200-354
  // (header 200-244), three notices the person expanded ("Show less").
  const base: StackMeasure = {
    ...BASE, viewportW: 1280, viewportH: 560, topLine: 150, card: null,
    column: { left: 340, right: 940 }, floating: { top: 200, bottom: 354, left: 340, right: 940 },
  };
  const three = { items: [46, 46, 46], gap: 8 };
  const line0 = 560 - 81;

  it('folded: the pill under the log, uncapped', () => {
    expect(placeNoticeStack({ ...base, notices: three })).toMatchObject({ more: 3, expanded: false, stackCap: null });
  });

  it('expanded: under the log (117 px there, 42 above), capped at that and scrolling, one notice and Show less in view', () => {
    const place = placeNoticeStack({ ...base, notices: three }, { expanded: true });
    expect(place).toMatchObject({ expanded: true, more: 3, lift: 0 });
    const under = line0 - (354 + FLOAT_GAP_PX);
    expect(place.stackCap).toBe(under);
    // The top of the stack: never the log (nor its header, nor the banner).
    expect(line0 - place.stackCap!).toBeGreaterThanOrEqual(354 + FLOAT_GAP_PX);
    expect(place.stackCap!).toBeGreaterThanOrEqual(MORE_ROW_PX + 8 + 46);
  });

  it('expanded, more room above: capped above it, under the banner', () => {
    const m = { ...base, floating: { top: 300, bottom: 454, left: 340, right: 940 } };
    const place = placeNoticeStack({ ...m, notices: three }, { expanded: true });
    const over = 300 - FLOAT_GAP_PX - 150;
    expect(place.stackCap).toBe(over);
    expect(place.lift).toBe(560 - 300 + FLOAT_GAP_PX - 81);
    // Its top at the banner's line, its foot over the log's top.
    expect(560 - 81 - place.lift - place.stackCap!).toBe(150);
  });

  it('expanded, with room for none on either side: under it, up into its body (the shortfall), never its header or the banner', () => {
    const m = { ...base, floating: { top: 230, bottom: 440, left: 340, right: 940 } };
    const place = placeNoticeStack({ ...m, notices: three }, { expanded: true });
    // 31 under it, 72 above, short of Show less and one notice (86).
    expect(place.lift).toBe(0);
    const top = line0 - place.stackCap!;
    expect(place.stackCap).toBe(MORE_ROW_PX + 8 + 46);
    expect(top).toBeGreaterThanOrEqual(230 + HEADER + FLOAT_GAP_PX);
    expect(top).toBeGreaterThanOrEqual(150);
    // A log low in the window, its body shorter than one notice: up to its
    // header's foot (and the gap), never into the header. 1 px under it, 12
    // above, 27 to the header (400 + 44 + 8).
    const low = placeNoticeStack({ ...m, topLine: 380, floating: { top: 400, bottom: 470, left: 340, right: 940 }, notices: three }, { expanded: true });
    expect(low.stackCap).toBe(line0 - (400 + HEADER + FLOAT_GAP_PX));
    // A banner low enough that even the body can't give it: as far as the banner allows.
    const deep = placeNoticeStack({ ...m, topLine: 420, notices: three }, { expanded: true });
    expect(line0 - deep.stackCap!).toBeGreaterThanOrEqual(420);
  });

  it('expanded with an Undo notice carrying "Show less": one notice is enough', () => {
    const m = { ...base, floating: { top: 230, bottom: 440, left: 340, right: 940 } };
    const place = placeNoticeStack({ ...m, notices: { ...three, undo: [false, false, true], host: [false, false, true] } }, { expanded: true });
    // Above it 72 px, under it 31: one notice (46) fits above, capped there.
    expect(place.moreHost).toBe(2);
    expect(place.stackCap).toBe(72);
    expect(place.lift).toBe(560 - 230 + FLOAT_GAP_PX - 81);
  });

  it('room on a side for the whole expansion: no cap', () => {
    expect(placeNoticeStack({ ...base, viewportH: 760, notices: three }, { expanded: true }).stackCap ?? null).toBe(null);
  });

  it('writes the cap on the region and the stack, and lifts it when it goes (noticeRegion.css scrolls it)', () => {
    document.body.innerHTML = '<div data-notice-region=""><div class="notice-region__stack"><button data-notice-more=""></button></div></div>';
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    const stack = region.querySelector<HTMLElement>('.notice-region__stack')!;
    applyNoticeStack(region, stack, placeNoticeStack({ ...base, notices: three }, { expanded: true }));
    expect(region.hasAttribute(STACK_CAP_ATTR)).toBe(true);
    expect(stack.style.getPropertyValue('--notice-stack-cap')).toBe(`${line0 - 362}px`);
    applyNoticeStack(region, stack, placeNoticeStack({ ...base, notices: three }));
    expect(region.hasAttribute(STACK_CAP_ATTR)).toBe(false);
    expect(stack.style.getPropertyValue('--notice-stack-cap')).toBe('');
    document.body.innerHTML = '';
    const css = readFileSync(join(__dirname, '../src/styles/noticeRegion.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.notice-region\[data-notice-stack-capped\] \.notice-region__stack \{[^}]*max-height: var\(--notice-stack-cap\);\s*overflow-y: auto;/);
  });
});

describe('review 4 NIT-1: the surviving mutants, pinned', () => {
  it('R3: glideStack settles once, when every move it started has finished', () => {
    const finishes: Array<() => void> = [];
    const els = [0, 1].map(() => {
      const el = document.createElement('div');
      el.getBoundingClientRect = () => ({ top: 100, bottom: 150, height: 50, left: 0, width: 100 }) as DOMRect;
      el.animate = (() => {
        const listeners: Array<() => void> = [];
        finishes.push(() => listeners.forEach((fn) => fn()));
        return { addEventListener: (_: string, fn: () => void) => listeners.push(fn), cancel() {} };
      }) as unknown as typeof el.animate;
      document.body.appendChild(el);
      return el;
    });
    const settled = vi.fn();
    const moved = glideStack(els.map((element) => ({ element, from: { top: 40, bottom: 90, height: 50, left: 0, width: 100 } })), 'ease-out', settled);
    expect(moved).toBe(2);
    finishes[0]();
    expect(settled).not.toHaveBeenCalled();
    finishes[1]();
    expect(settled).toHaveBeenCalledTimes(1);
    els.forEach((el) => el.remove());
  });

  it('R31: with no card, the measure reads which notice can carry the fold\'s count', () => {
    document.body.innerHTML = `
      <div data-notice-region=""><div class="notice-region__stack">
        <div data-notice-slot="a"><div class="toast"><span>Saved.</span></div></div>
        <div data-notice-slot="b"><div class="toast"><button>Undo</button><span ${MORE_SLOT_ATTR}=""></span></div></div>
      </div></div>`;
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    const stack = region.querySelector<HTMLElement>('.notice-region__stack')!;
    const spy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('toast') ? 46 : 0; });
    const measured = measureNoticeStack(region, stack, 16);
    expect(measured.notices!.host).toEqual([false, true]);
    spy.mockRestore();
    document.body.innerHTML = '';
  });

  it('F2: under a floating log counts the 8 px gap under its foot', () => {
    // 1024x656, the log across the column at 280-324: under it 575 - 332 =
    // 243 with the gap, 251 without; the note whole needs 89 + 158 = 247.
    // Above it 280 - 8 - 16 = 256: the card goes above, the note whole.
    const m = cell({ viewportW: 1024, viewportH: 656, topLine: 16, column: { left: 212, right: 812 }, floating: { top: 280, bottom: 324, left: 100, right: 924 } });
    expect(placeNoticeStack(m)).toMatchObject({ float: 'above', keepPlan: false });
  });

  it('F16: in a shortfall, beside the log is among the places the body may have the most room', () => {
    // 1024x300 under a banner at 80: beside the log (448 px on its left) the
    // body has 139 - 89 = 50 (one line, short of the kept lines); under and
    // above it, nothing.
    const m = cell({ viewportW: 1024, viewportH: 300, topLine: 80, column: { left: 212, right: 812 }, floating: { top: 60, bottom: 210, left: 520, right: 700 } });
    const place = placeNoticeStack(m);
    expect(place.float).toBe('left');
    clearOfBannerAndHeader(m, place);
  });
});

describe('review 4 logic NIT-3: the open log\'s max-height while a give springs back', () => {
  it('a give of 0.001 px or more bounds it at its shown height on a window up to 12,500 px tall', () => {
    const css = readFileSync(join(__dirname, '../src/styles/layouts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const match = /max-height: max\(var\(--agent-log-shown-h\), calc\(80vh - var\(--agent-log-give\) \* (\d+)\)\);/.exec(css);
    expect(match).toBeTruthy();
    const times = Number(match![1]);
    // The second term is under 0 there, so max() takes the shown height.
    expect(0.8 * 12_500 - 0.001 * times).toBeLessThanOrEqual(0);
    // No give: main's 80vh.
    expect(0.8 * 900 - 0 * times).toBe(720);
  });
});
