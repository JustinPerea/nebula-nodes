import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoticeRegion } from '../src/components/NoticeRegion';
import { AgentLog } from '../src/components/panels/AgentLog';
import { LOG_HELD_ATTR } from '../src/lib/noticeStackPlace';
import { useUIStore } from '../src/store/uiStore';

/**
 * PR #216 review 3 MEDIUM-3: after the card leaves, notices still showing
 * place clear of a floating log: their column is read from the layout (the
 * region with no inset, the stack centred in it), never from the boxes they
 * draw mid-glide, and the region places again when a glide ends.
 *
 * GM r57 Q1: while the person holds a floating log in a drag, it rises above
 * the card and the card holds still (no glide, no chasing); at the drop it
 * places once, on the layout spring.
 *
 * The layout is mocked: a 1024x640 window, the region's line 81 px up, a
 * floating log at 200-540 x 400-554 (review 3's p4/p5 repro).
 */
const root = () => document.documentElement;
const FLOAT = ['top', 'bottom', 'left', 'right'] as const;
const setFloat = (box: { top: number; bottom: number; left: number; right: number }) => {
  for (const side of FLOAT) root().style.setProperty(`--agent-log-float-${side}`, `${box[side]}px`);
};

/** Mocked layout: the region (narrower while a card's inset is on it), the
 * notices (their layout width, and boxes drawn wherever `drawnAt` says), the card. */
const layout = { drawnLeft: 560, noticeW: 243, regionLeft: 64 };
let moves: Array<{ element: Element; finish: () => void }> = [];

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });
  layout.drawnLeft = 560;
  layout.noticeW = 243;
  layout.regionLeft = 64;
  moves = [];
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const region = document.querySelector<HTMLElement>('[data-notice-region]');
    const inset = region?.style.left ? Number.parseFloat(region.style.left) : null;
    if (this === region) {
      const left = inset ?? layout.regionLeft;
      const right = 1024 - (region!.style.right ? Number.parseFloat(region!.style.right) : 16);
      return { left, right, width: right - left, top: 0, bottom: 559, height: 559 } as DOMRect;
    }
    if (this.classList.contains('toast')) return { left: layout.drawnLeft, right: layout.drawnLeft + layout.noticeW, width: layout.noticeW, top: 460, bottom: 506, height: 46 } as DOMRect;
    // The card where the region lays it out: centred in it, 600 wide at most.
    if (this.classList.contains('card')) {
      const left = inset ?? layout.regionLeft;
      const right = 1024 - (region!.style.right ? Number.parseFloat(region!.style.right) : 16);
      const width = Math.min(600, right - left);
      const x = left + (right - left - width) / 2;
      return { left: x, right: x + width, width, top: 100, bottom: 466, height: 366 } as DOMRect;
    }
    return { left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0 } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('toast') ? 46 : this.classList.contains('card') ? 366 : this.classList.contains('scroll') ? 266 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('toast') ? layout.noticeW : this.classList.contains('card') ? 600 : 0;
  });
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: vi.fn(function (this: HTMLElement) {
      const listeners: Array<() => void> = [];
      const move = { cancel() {}, addEventListener: (type: string, fn: () => void) => { if (type === 'finish') listeners.push(fn); } };
      moves.push({ element: this, finish: () => listeners.forEach((fn) => fn()) });
      return move as unknown as Animation;
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  for (const side of FLOAT) root().style.removeProperty(`--agent-log-float-${side}`);
  root().removeAttribute(LOG_HELD_ATTR);
  document.body.innerHTML = '';
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const lift = () => document.querySelector<HTMLElement>('[data-notice-region]')!.style.getPropertyValue('--notice-stack-lift');

async function notices(count: number): Promise<HTMLElement[]> {
  const slots = [...document.querySelectorAll<HTMLElement>('[data-notice-slot]')].filter((slot) => slot.dataset.noticeSlot !== 'proposal');
  const items = Array.from({ length: count }, (_, i) => {
    const toast = document.createElement('div');
    toast.className = `toast t${i}`;
    toast.innerHTML = '<span>Saved.</span><button type="button" aria-label="Dismiss">×</button>';
    slots[i].appendChild(toast);
    return toast;
  });
  await flush();
  return items;
}

describe('review 3 MEDIUM-3: the card gone, notices mid-glide still clear a floating log', () => {
  it('reads the column from the layout: the notices drawn beside the log mid-glide still lift clear of it', async () => {
    setFloat({ top: 400, bottom: 554, left: 200, right: 540 });
    render(<NoticeRegion screen="home" />);
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    // The inset the card left (beside the log, on its right) is still on the
    // region, and the notices draw there, mid-glide back to the centre.
    region.style.left = '548px';
    region.style.right = '16px';
    await notices(2);
    // Their column with no inset: 536 ± 121.5, over the log (200-540): above
    // it, its top 400 + the gap, 81 px over the window's foot.
    expect(lift()).toBe(`${640 - 400 + 8 - 81}px`);
    // The inset is written away (no card, no floating side).
    expect([region.style.left, region.style.right]).toEqual(['', '']);
  });

  it('places again when a glide ends, from where the rows came to rest', async () => {
    setFloat({ top: 400, bottom: 554, left: 200, right: 540 });
    render(<NoticeRegion screen="home" />);
    await notices(2);
    expect(lift()).toBe('167px');
    // A drop places with a glide (GM r57 Q1); the rows were drawn elsewhere,
    // so they glide.
    act(() => { root().setAttribute(LOG_HELD_ATTR, ''); });
    await flush();
    layout.drawnLeft = 300;
    act(() => { root().removeAttribute(LOG_HELD_ATTR); });
    await flush();
    const glide = moves.splice(0);
    expect(glide.length).toBe(2);
    // While it runs, the region's layout moves (nothing the region watches
    // tells it): its column is now clear of the log, right of it.
    layout.regionLeft = 600;
    await flush();
    expect(lift()).toBe('167px');
    // The glide ends: the region places again, from the layout.
    act(() => { glide.forEach((move) => move.finish()); });
    await flush();
    expect(lift()).toBe('0px');
  });
});

describe('GM r57 Q1: the person\'s hand wins', () => {
  const card = () => {
    const slot = document.querySelector<HTMLElement>('[data-notice-slot="proposal"]')!;
    slot.innerHTML = `<div class="card" data-notice-shrinks="">
      <div class="head"></div><div class="scroll" data-notice-shrink-body=""><div class="body"></div></div><div class="foot" data-notice-shrink-foot=""></div>
    </div>`;
    return slot.firstElementChild as HTMLElement;
  };

  it('while a floating log is held in a drag, the card holds still; at the drop it places once, on the spring', async () => {
    setFloat({ top: 150, bottom: 330, left: 65, right: 405 });
    render(<NoticeRegion screen="home" />);
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    const el = card();
    await flush();
    // Beside the log, on its right (595 px there).
    expect([region.style.left, region.style.right]).toEqual(['413px', '16px']);
    const rest = () => ({ inset: [region.style.left, region.style.right], lift: lift(), cap: el.style.getPropertyValue('--notice-card-cap'), rect: el.getBoundingClientRect().left });
    const before = rest();
    moves = [];
    // The person picks the log up and drags it across the card's column to
    // the right edge: every frame moves its box on the root.
    act(() => { root().setAttribute(LOG_HELD_ATTR, ''); });
    for (const left of [120, 200, 300, 420, 520, 600]) {
      act(() => setFloat({ top: 150, bottom: 330, left, right: left + 340 }));
      await flush();
      expect(rest()).toEqual(before);
    }
    expect(moves).toEqual([]);
    // The drop: one place, beside it on its left now, gliding there.
    act(() => { root().removeAttribute(LOG_HELD_ATTR); });
    await flush();
    expect([region.style.left, region.style.right]).toEqual(['64px', '432px']);
    expect(moves.map((move) => move.element)).toEqual([el]);
    const after = rest();
    // Settled: nothing more moves.
    act(() => { moves.splice(0).forEach((move) => move.finish()); });
    await flush();
    expect(rest()).toEqual(after);
    expect(moves).toEqual([]);
  });

  it('the log marks the root while held, rises above the card, and lets go at the drop', () => {
    window.localStorage.setItem('nebula:agentLog:pos', JSON.stringify({ left: 300, top: 300, anchorX: 'left', anchorY: 'top' }));
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: true, agentLogCardHold: 'none' } as never);
    const { container, unmount } = render(<AgentLog />);
    const row = container.querySelector<HTMLElement>('.agent-log__drag-row')!;
    fireEvent.mouseDown(row, { button: 0, clientX: 310, clientY: 310 });
    // A press is not a drag: under the threshold, no mark.
    fireEvent.mouseMove(window, { clientX: 311, clientY: 311 });
    expect(root().hasAttribute(LOG_HELD_ATTR)).toBe(false);
    fireEvent.mouseMove(window, { clientX: 340, clientY: 330 });
    expect(root().hasAttribute(LOG_HELD_ATTR)).toBe(true);
    fireEvent.mouseUp(window);
    expect(root().hasAttribute(LOG_HELD_ATTR)).toBe(false);
    // Unmounted mid-drag: the mark goes with it.
    fireEvent.mouseDown(row, { button: 0, clientX: 310, clientY: 310 });
    fireEvent.mouseMove(window, { clientX: 360, clientY: 330 });
    expect(root().hasAttribute(LOG_HELD_ATTR)).toBe(true);
    unmount();
    expect(root().hasAttribute(LOG_HELD_ATTR)).toBe(false);
    window.localStorage.removeItem('nebula:agentLog:pos');
    useUIStore.setState({ agentLogOpen: false } as never);
    const css = readFileSync(resolve(__dirname, '../src/styles/layouts.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/:root\[data-agent-log-held\] \.agent-log \{\s*z-index: calc\(var\(--sr-layer-notice, 20010\) \+ 1\);\s*\}/);
  });
});
