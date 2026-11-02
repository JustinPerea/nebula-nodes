import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BESIDE_LOG_MIN_W,
  MIN_BODY_PX,
  applyNoticeStack,
  measureNoticeStack,
  placeNoticeStack,
  type StackMeasure,
} from '../src/lib/noticeStackPlace';

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
    // The body keeps its minimum whenever the window has room for it.
    expect(box.height).toBeGreaterThanOrEqual(Math.min(CHROME + MIN_BODY_PX, m.viewportH - m.regionBottom - m.card!.below - m.topLine));
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

  it('keeps the body at its minimum by coming down over the log, never past the inset (review 1 MEDIUM-2)', () => {
    const m = measure({ viewportH: 700, logHeight: 492, card: { below: NOTICE, chrome: CHROME, body: 600 } });
    const box = cardBox(m);
    expect(box.cap).toBe(CHROME + MIN_BODY_PX);
    expect(box.top).toBe(m.topLine);
    const logTopY = m.viewportH - 492;
    // Its foot overlaps the log's top edge; the log itself never moves.
    expect(box.bottom).toBeGreaterThan(logTopY);
    // A body shorter than the minimum keeps its own height.
    expect(placeNoticeStack({ ...m, card: { below: 0, chrome: CHROME, body: 20 } }).cap).toBeGreaterThanOrEqual(CHROME + 20);
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
    expect(m.card).toEqual({ below: 54, chrome: 100, body: 700 });
    applyNoticeStack(region, stack, placeNoticeStack(m));
    expect(region.dataset.aboveLog).toBe('true');
    expect(region.style.getPropertyValue('--notice-stack-lift')).toBe('126px');
    expect(document.querySelector<HTMLElement>('.card')!.style.getPropertyValue('--notice-card-cap'))
      .toBe(`${900 - 80 - 126 - 54 - 72}px`);
  });

  it('re-measures when the stack, the top bars or the root variables change (review 1 HIGH-1, LOW-5)', () => {
    expect(REGION).toMatch(/watch\(stack\)/);
    expect(REGION).toMatch(/querySelectorAll\(`\[\$\{TOP_BAR_ATTR\}\]`\)\.forEach\(watch\)/);
    expect(REGION).toMatch(/observe\(document\.documentElement, \{ attributes: true, attributeFilter: \['style'\] \}\)/);
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
    expect(scroll['min-height']).toBe('0');
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
