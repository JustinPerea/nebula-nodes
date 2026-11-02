import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BESIDE_LOG_MIN_W,
  FLOAT_GAP_PX,
  JUMP_ATTR,
  MIN_BODY_PX,
  applyNoticeStack,
  measureNoticeStack,
  placeNoticeStack,
  stackJumps,
  type StackMeasure,
} from '../src/lib/noticeStackPlace';
import { NOTICE_TOP_LINE_ATTR, noticeTopLimit } from '../src/lib/bottomBar';

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
const NOTICE = 46 + 8;
const CHROME = 34 + 55 + 2;
function measure(over: Partial<StackMeasure> & { logHeight?: number; logOpen?: boolean }): StackMeasure {
  const { logHeight = 198, logOpen = true, ...rest } = over;
  const viewportH = rest.viewportH ?? 900;
  return {
    viewportW: 420, viewportH, gutter: 16, regionLeft: 70, regionBottom: 80,
    logClearance: logOpen ? 348 : 0, logTop: logOpen ? logHeight + 8 : 0, topLine: 72,
    card: { below: 0, chrome: CHROME, body: 400 },
    ...rest,
  };
}

/** Where the card lands, from the window's top. */
function cardBox(m: StackMeasure) {
  const place = placeNoticeStack(m);
  const height = Math.min(place.cap!, m.card!.chrome + m.card!.body);
  const bottom = m.viewportH - m.regionBottom - place.lift - m.card!.below;
  return { ...place, top: bottom - height, bottom, height };
}

describe('the notice stack and the Agent log', () => {
  it.each([
    ['420x900, log open, 1 notice', measure({ card: { below: NOTICE, chrome: CHROME, body: 400 } })],
    ['420x640', measure({ viewportH: 640 })],
    ['420x560', measure({ viewportH: 560, card: { below: NOTICE, chrome: CHROME, body: 600 } })],
    ['900, Show all, 2 notices', measure({ viewportW: 900, card: { below: 2 * NOTICE, chrome: CHROME, body: 1200 } })],
    ['the log dragged up', measure({ viewportH: 700, logHeight: 492, card: { below: NOTICE, chrome: CHROME, body: 600 } })],
    ['the selection toolbar showing', measure({ topLine: 150, card: { below: NOTICE, chrome: CHROME, body: 900 } })],
  ])('%s: the card top is at or below the inset and its footer fully shows', (_name, m) => {
    const box = cardBox(m);
    expect(box.top).toBeGreaterThanOrEqual(m.topLine);
    expect(box.bottom).toBeLessThanOrEqual(m.viewportH);
    // Header, at least one line of body and footer always show (GM r4 5).
    expect(box.height).toBeGreaterThanOrEqual(CHROME + 20);
    // With no notices to give way for, the body keeps its minimum whenever the room above the log allows.
    const room = m.viewportH - m.regionBottom - Math.max(0, m.logTop - m.regionBottom) - m.topLine;
    if (m.card!.below === 0 && box.aboveLog) expect(box.height).toBeGreaterThanOrEqual(Math.min(CHROME + MIN_BODY_PX, room));
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
    const withTwo = placeNoticeStack(measure({ viewportW: 900, card: { below: 2 * NOTICE, chrome: CHROME, body: 400 } }));
    expect(alone.cap! - withTwo.cap!).toBe(2 * NOTICE);
  });

  it('keeps the body at its minimum and the card under the inset when the room allows', () => {
    const m = measure({ viewportH: 700, logHeight: 400, card: { below: 0, chrome: CHROME, body: 600 } });
    const box = cardBox(m);
    expect(box.top).toBeGreaterThanOrEqual(m.topLine);
    expect(box.bottom).toBeLessThanOrEqual(700 - 400);
  });
});

// GM - Design, PR #216 r4 5, at 420x560 with the log open (the live check's
// numbers, round 3b): region line 81 up, the stack's line 188 over it, the top
// line 116, header 34 + footer 53 + borders, notices 46 tall with 8 px gaps.
const LIVE = {
  viewportW: 420, viewportH: 560, gutter: 16, regionLeft: 64, regionBottom: 81,
  logClearance: 348, logTop: 269, topLine: 116,
};
const LIVE_CARD = { chrome: 89, body: 198, foot: 54, line: 20, gap: 8 };

function liveBox(m: StackMeasure) {
  const place = placeNoticeStack(m);
  const pad = place.overlay?.pad ?? 0;
  const height = Math.min(place.cap!, Math.max(m.card!.chrome + (place.overlay?.floor ?? 0),
    m.card!.chrome + m.card!.body + pad));
  const bottom = m.viewportH - m.regionBottom - place.lift - m.card!.below;
  return { place, top: bottom - height, bottom, height };
}

describe('the give-way order (GM r4 5)', () => {
  const logHeader = LIVE.viewportH - LIVE.logTop + 8; // the log's top edge, under its gap

  it('1: notices with no room under the card go over its body\'s foot, never over the log', () => {
    const m: StackMeasure = { ...LIVE, card: { ...LIVE_CARD, below: 108, items: [46, 46] } };
    const { place, top, bottom } = liveBox(m);
    expect(place.overlay).not.toBeNull();
    // The card sits on the stack's line, clear of the log's header, under the inset.
    expect(bottom).toBe(LIVE.viewportH - LIVE.regionBottom - (LIVE.logTop - LIVE.regionBottom));
    expect(bottom).toBeLessThan(logHeader);
    expect(top).toBeGreaterThanOrEqual(LIVE.topLine);
    // Each notice lands inside the body, the last one just above the footer.
    const { offsets } = place.overlay!;
    const layout = [8, 8 + 46 + 8];
    const visual = offsets.map((offset, index) => bottom + layout[index] + offset);
    expect(visual[1] + 46).toBe(bottom - LIVE_CARD.foot - 8);
    expect(visual[0]).toBeGreaterThanOrEqual(top + 34);
    // Older ones tuck under the newest only when the body can't hold both.
    expect(visual[0] + 46).toBeGreaterThan(visual[1]);
    // With room for both under one another, no notice overlaps another.
    const roomy = placeNoticeStack({ ...m, viewportH: 640, card: { ...LIVE_CARD, below: 108, items: [46, 46], body: 400 } });
    if (roomy.overlay) {
      const tops = roomy.overlay.offsets.map((offset, index) => layout[index] + offset);
      expect(tops[0] + 46 + 8).toBeLessThanOrEqual(tops[1]);
    }
  });

  it('2: with no notices the body shrinks below the minimum, down to one line, before the card covers the log', () => {
    const m: StackMeasure = { ...LIVE, card: { ...LIVE_CARD, below: 0 } };
    const short = { ...m, topLine: LIVE.viewportH - LIVE.regionBottom - (LIVE.logTop - LIVE.regionBottom) - (89 + 30) };
    const place = placeNoticeStack(short);
    expect(place.cap).toBe(89 + 30);
    expect(place.lift).toBe(LIVE.logTop - LIVE.regionBottom);
  });

  it('3: only when header, one line and footer can\'t fit does the card\'s foot come down', () => {
    const m: StackMeasure = { ...LIVE, card: { ...LIVE_CARD, below: 0 } };
    const line = LIVE.viewportH - LIVE.regionBottom - (LIVE.logTop - LIVE.regionBottom);
    const place = placeNoticeStack({ ...m, topLine: line - (89 + 10) });
    expect(place.cap).toBe(89 + 20);
    expect(place.lift).toBe(LIVE.logTop - LIVE.regionBottom - 10);
    // With notices over the body: header, the newest notice and footer.
    const crowded = placeNoticeStack({ ...m, topLine: line - (89 + 40), card: { ...LIVE_CARD, below: 54, items: [46] } });
    expect(crowded.cap).toBe(89 + 8 + 46);
    expect(crowded.lift + 54).toBe(LIVE.logTop - LIVE.regionBottom - (8 + 46 - 40));
  });

  it('a body shorter than the minimum needs no give-way (review 2 NIT-5)', () => {
    const line = LIVE.viewportH - LIVE.regionBottom - (LIVE.logTop - LIVE.regionBottom);
    const m: StackMeasure = { ...LIVE, topLine: line - 54 - (89 + 30), card: { ...LIVE_CARD, body: 30, below: 54, items: [46] } };
    const place = placeNoticeStack(m);
    expect(place.overlay).toBeNull();
    expect(place.cap).toBe(89 + 30);
  });

  it('clears a floating log in the card\'s column: under it with room, else above it (GM r4 6)', () => {
    const base = { ...LIVE, viewportH: 900, logClearance: 0, logTop: 0, column: { left: 64, right: 404 } };
    const card = { ...LIVE_CARD, below: 0 };
    const high = placeNoticeStack({ ...base, card, floating: { top: 120, bottom: 300, left: 65, right: 403 } });
    expect(high.topLine).toBe(300 + FLOAT_GAP_PX);
    expect(high.lift).toBe(0);
    const low = placeNoticeStack({ ...base, card, floating: { top: 500, bottom: 760, left: 65, right: 403 } });
    expect(low.lift).toBe(900 - 500 + FLOAT_GAP_PX - LIVE.regionBottom);
    const aside = placeNoticeStack({ ...base, card, floating: { top: 500, bottom: 760, left: 600, right: 900 } });
    expect(aside.lift).toBe(0);
    expect(aside.topLine).toBe(LIVE.topLine);
  });

  it('a layout switch lands with no spring for its frame; a notice coming or going keeps it (review 2 MEDIUM-1)', () => {
    const place = (aboveLog: boolean) => ({ aboveLog, lift: 0, cap: null });
    expect(stackJumps(null, { place: place(true), logTop: 206, floatTop: 0 })).toBe(false);
    expect(stackJumps({ place: place(false), logTop: 206, floatTop: 0 }, { place: place(true), logTop: 206, floatTop: 0 })).toBe(true);
    expect(stackJumps({ place: place(true), logTop: 206, floatTop: 0 }, { place: place(true), logTop: 306, floatTop: 0 })).toBe(true);
    expect(stackJumps({ place: place(true), logTop: 0, floatTop: 300 }, { place: place(true), logTop: 0, floatTop: 320 })).toBe(true);
    expect(stackJumps({ place: place(true), logTop: 206, floatTop: 0 }, { place: { ...place(true), lift: 40 }, logTop: 206, floatTop: 0 })).toBe(false);
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
    applyNoticeStack(region, stack, { aboveLog: true, lift: 126, cap: null }, true);
    expect(region.hasAttribute(JUMP_ATTR)).toBe(true);
    expect(region.style.getPropertyValue('--notice-stack-lift')).toBe('126px');
    frames.shift()!();
    expect(region.hasAttribute(JUMP_ATTR)).toBe(true);
    frames.shift()!();
    expect(region.hasAttribute(JUMP_ATTR)).toBe(false);
    applyNoticeStack(region, stack, { aboveLog: true, lift: 80, cap: null });
    expect(region.hasAttribute(JUMP_ATTR)).toBe(false);
    vi.unstubAllGlobals();
  });

  it('the region watches its root marks and wires the jump in', () => {
    expect(REGION).toMatch(/applyNoticeStack\(region, stack, next\.place, stackJumps\(last, next\)\)/);
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
    document.body.innerHTML = '';
  });

  it('reads what is under the card, its fixed rows and the log, and writes the mode, lift and cap', () => {
    document.documentElement.style.setProperty('--agent-log-clearance', '348px');
    document.documentElement.style.setProperty('--agent-log-top', '206px');
    document.body.innerHTML = `
      <div data-notice-region=""><div class="notice-region__stack">
        <div data-notice-slot="proposal"><div class="card" data-notice-shrinks="">
          <div class="head"></div><div class="scroll" data-notice-shrink-body=""><div class="body"></div></div><div class="foot"></div>
        </div></div>
        <div data-notice-slot="canvas"><div class="toast"></div></div>
      </div></div>`;
    const boxes: Record<string, [number, number]> = {
      '[data-notice-region]': [70, 820], '.notice-region__stack': [0, 820], '.card': [400, 766], '.scroll': [0, 300],
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const hit = Object.entries(boxes).find(([selector]) => this.matches(selector));
      const [a, b] = hit?.[1] ?? [0, 0];
      // [left, bottom] for the region and stack, [height, bottom] for the card, [_, height] for the body.
      if (this.matches('.card')) return { top: b - a, bottom: b, height: a, left: 0, right: 0, width: 0 } as DOMRect;
      if (this.matches('.scroll')) return { top: 0, bottom: b, height: b, left: 0, right: 0, width: 0 } as DOMRect;
      return { top: 0, bottom: b, height: 0, left: a, right: 0, width: 0 } as DOMRect;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('body') ? 700 : 0;
    });
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    const stack = document.querySelector<HTMLElement>('.notice-region__stack')!;
    Object.defineProperty(window, 'innerWidth', { value: 420, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    const m = measureNoticeStack(region, stack, 72);
    expect(m).toMatchObject({ regionLeft: 70, regionBottom: 80, logClearance: 348, logTop: 206, topLine: 72 });
    expect(m.card).toMatchObject({ below: 54, chrome: 100, body: 700, items: [0] });
    applyNoticeStack(region, stack, placeNoticeStack(m));
    expect(region.dataset.aboveLog).toBe('true');
    expect(region.style.getPropertyValue('--notice-stack-lift')).toBe('126px');
    expect(document.querySelector<HTMLElement>('.card')!.style.getPropertyValue('--notice-card-cap'))
      .toBe(`${900 - 80 - 126 - 54 - 72}px`);
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
    // Give-way step 1 (GM r4 5): the notices' room at the body's foot.
    expect(scroll['min-height']).toBe('var(--notice-body-floor, 0px)');
    expect(scroll['padding-bottom']).toBe('var(--notice-overlay-pad, 0px)');
    expect(scroll['box-sizing']).toBe('border-box');
    const overlaid = rule(REGION_CSS, ".notice-region[data-notice-overlay='true'] .notice-region__slot > :not([data-notice-shrinks])");
    expect(overlaid.translate).toBe('0 var(--notice-overlay-y, 0px)');
    expect(overlaid['z-index']).toBe('1');
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
