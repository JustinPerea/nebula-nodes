/**
 * PR #204 round 18 (GM r28 2): the notice stack is centred above the bottom bar like every toast,
 * and moves clear of an open side panel, or narrows to fit, never drawing over one. The region
 * (components/NoticeRegion) measures the side panels that reach its band while it holds a notice
 * (lib/noticeSides.ts) and noticeRegion.css places it from what they take. The CSS is read from
 * the sheet and evaluated here, so the numbers are the sheet's own.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIDE_PANEL_GAP, sideClearance, watchSidePanels } from '../src/lib/noticeSides';

const SHEET = readFileSync(join(__dirname, '../src/styles/noticeRegion.css'), 'utf8');
const regionRule = /\n\.notice-region \{([^}]*)\}/.exec(SHEET)![1];
const decl = (prop: string) => new RegExp(`(?:^|\\n)\\s*${prop}:\\s*([^;]+);`).exec(regionRule)![1].trim();

/** Evaluates one of the region's CSS lengths (max, min, calc, var with fallbacks, px, vw). */
function evaluate(expression: string, vars: Record<string, number>, width: number): number {
  let text = expression;
  for (let i = 0; i < 10 && /var\(/.test(text); i += 1) {
    text = text.replace(/var\((--[\w-]+)(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name: string, fallback?: string) => {
      if (name in vars) return `${vars[name]}px`;
      const own = /(?:^|\n)\s*(--[\w-]+):\s*([^;]+);/g;
      for (const [, prop, value] of regionRule.matchAll(own)) if (prop === name) return `(${value})`;
      return fallback ?? '0px';
    });
  }
  const js = text.replace(/(\d+(?:\.\d+)?)vw/g, (_, n) => `${(Number(n) / 100) * width}`).replace(/px/g, '')
    .replace(/\bmax\(/g, 'Math.max(').replace(/\bmin\(/g, 'Math.min(').replace(/\bcalc\(/g, '(');
  return Function(`return (${js});`)() as number;
}
/** The region's left and right insets for a window `width` and the clearances given. */
function insets(width: number, clear: { left?: number; right?: number; log?: number }) {
  const vars: Record<string, number> = { '--page-gutter': 16 };
  if (clear.left) vars['--notice-left-clearance'] = clear.left;
  if (clear.right) vars['--notice-right-clearance'] = clear.right;
  if (clear.log) vars['--agent-log-clearance'] = clear.log;
  const left = evaluate(decl('left'), vars, width);
  const right = evaluate(decl('right'), vars, width);
  return { left, right, centre: (left + width - right) / 2, room: width - left - right };
}

describe('the region\'s place (noticeRegion.css), at 1440', () => {
  it('nothing open: centred on the window, the bar\'s centre', () => {
    expect(insets(1440, {})).toEqual({ left: 16, right: 16, centre: 720, room: 1408 });
  });
  it('the docked Agent log: still centred (it narrows), not centred in what is left', () => {
    const at = insets(1440, { log: 389 });
    expect(at.centre).toBe(720);
    expect(at.right).toBe(389);
    expect(at.left).toBe(389);
  });
  it('the Nodes drawer open on the left: clear of it, centred, narrower', () => {
    const at = insets(1440, { left: 424 });
    expect(at.left).toBe(424);
    expect(at.centre).toBe(720);
  });
  it('both: each side takes the larger, still centred', () => {
    const at = insets(1440, { left: 424, log: 389 });
    expect(at).toMatchObject({ left: 424, right: 424, centre: 720 });
  });
  it('the Settings drawer (400 px wide) and the log: still centred, narrower (measured live: 478 and 395)', () => {
    expect(insets(1440, { left: 478, log: 395 })).toMatchObject({ left: 478, right: 478, centre: 720, room: 484 });
  });
  it('too little room to stay centred (under 420 px): it gives up the centre as little as it must', () => {
    const at = insets(1024, { log: 389 });
    expect(at.right).toBe(389);
    expect(at.room).toBe(420);
    expect(at.left).toBe(1024 - 389 - 420);
  });
  it('and never under a panel, however little room is left', () => {
    const at = insets(1024, { left: 424, log: 389 });
    expect(at.left).toBeGreaterThanOrEqual(424);
    expect(at.right).toBeGreaterThanOrEqual(389);
  });
});

describe('what a side panel takes (lib/noticeSides)', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = ''; });
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  function page(panels: Array<[string, DOMRect]>) {
    const region = document.createElement('div');
    region.className = 'notice-region';
    const band = document.createElement('div');
    band.setAttribute('data-notice-band', '');
    region.append(band);
    const slot = document.createElement('div');
    slot.setAttribute('data-notice-slot', 'pin');
    region.append(slot);
    document.body.append(region);
    const boxes = new Map<Element, DOMRect>([[band, rect(16, 769, 1408, 74)]]);
    for (const [className, box] of panels) {
      const panel = document.createElement('div');
      panel.className = className;
      document.body.append(panel);
      boxes.set(panel, box);
    }
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) { return boxes.get(this) ?? rect(0, 0, 0, 0); });
    return { region, slot };
  }

  it('the Nodes drawer down to the band: its right edge and the gap', () => {
    const { region } = page([['panel workspace-dock-panel', rect(72, 140, 344, 649)]]);
    expect(sideClearance(region, 1440)).toEqual({ left: 416 + SIDE_PANEL_GAP, right: 0 });
  });
  it('a drawer that stops above the band takes nothing', () => {
    const { region } = page([['panel workspace-dock-panel', rect(72, 140, 344, 600)]]);
    expect(sideClearance(region, 1440)).toEqual({ left: 0, right: 0 });
  });
  it('a panel on the right (the chat) takes from the right; one leaving takes nothing', () => {
    const { region } = page([['chat-panel', rect(1060, 300, 364, 520)], ['panel workspace-dock-panel panel--exiting', rect(72, 140, 344, 700)]]);
    expect(sideClearance(region, 1440)).toEqual({ left: 0, right: 1440 - 1060 + SIDE_PANEL_GAP });
  });
  it('the region writes it only while it holds a notice', async () => {
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => { run(0); return 1; });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    const { region, slot } = page([['panel workspace-dock-panel', rect(72, 140, 344, 649)]]);
    const stop = watchSidePanels(region);
    expect(region.style.getPropertyValue('--notice-left-clearance')).toBe('');
    const toast = document.createElement('div');
    await act(async () => { slot.append(toast); await Promise.resolve(); });
    expect(region.style.getPropertyValue('--notice-left-clearance')).toBe(`${416 + SIDE_PANEL_GAP}px`);
    await act(async () => { toast.remove(); await Promise.resolve(); });
    expect(region.style.getPropertyValue('--notice-left-clearance')).toBe('');
    stop();
    vi.unstubAllGlobals();
  });
});

describe('the region runs it', () => {
  it('NoticeRegion watches its side panels', async () => {
    const { NoticeRegion } = await import('../src/components/NoticeRegion');
    const spy = await import('../src/lib/noticeSides');
    expect(readFileSync(join(__dirname, '../src/components/NoticeRegion.tsx'), 'utf8')).toMatch(/watchSidePanels\(region\)/);
    const view = render(<NoticeRegion screen="home" />);
    expect(document.querySelector('.notice-region')).not.toBeNull();
    view.unmount();
    void spy;
  });
});
