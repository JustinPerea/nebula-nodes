import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoticeRegion } from '../src/components/NoticeRegion';
import { GLIDE_MS, LOG_HELD_ATTR, LOG_SETTLING_ATTR } from '../src/lib/noticeStackPlace';

/**
 * PR #216 round 3l.
 * GM r69 Q3 (review 4 logic LOW-3): a drag that starts from the docked log
 * freezes the card's sides for the whole drag, as a floating drag does. The
 * log leaving the dock clears its clearance on the root at once (AgentLog),
 * which the region's own CSS right edge reads; frozen inline, the card
 * neither re-centres nor widens mid-drag. At the drop it places once, on the
 * layout spring.
 * GM r69 Q5 (review 4 layout NIT-1): from the drop, the log stays above the
 * card (`data-agent-log-settling`, layouts.css) until the card's glide
 * rests; then the stacking drops back.
 *
 * The layout is mocked: a 1024x640 window, the region's line 81 px up; its
 * right edge is CSS's max(gutter, --agent-log-clearance) unless set inline.
 */
const root = () => document.documentElement;
const FLOAT = ['top', 'bottom', 'left', 'right'] as const;
const setFloat = (box: { top: number; bottom: number; left: number; right: number } | null) => {
  for (const side of FLOAT) {
    if (box) root().style.setProperty(`--agent-log-float-${side}`, `${box[side]}px`);
    else root().style.removeProperty(`--agent-log-float-${side}`);
  }
};
const dock = (on: boolean) => {
  if (on) {
    root().style.setProperty('--agent-log-clearance', '372px');
    root().style.setProperty('--agent-log-top', '330px');
  } else {
    root().style.removeProperty('--agent-log-clearance');
    root().style.removeProperty('--agent-log-top');
  }
};

let moves: Array<{ element: Element; finish: () => void }> = [];

/** The region's box as CSS lays it out. */
function regionBox(region: HTMLElement) {
  const clearance = Number.parseFloat(root().style.getPropertyValue('--agent-log-clearance')) || 0;
  const left = region.style.left ? Number.parseFloat(region.style.left) : 64;
  const right = 1024 - (region.style.right ? Number.parseFloat(region.style.right) : Math.max(16, clearance));
  return { left, right };
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });
  moves = [];
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const region = document.querySelector<HTMLElement>('[data-notice-region]');
    if (this === region) {
      const { left, right } = regionBox(region!);
      return { left, right, width: right - left, top: 0, bottom: 559, height: 559 } as DOMRect;
    }
    // The card where the region lays it out: centred in it, 600 wide at most.
    if (this.classList.contains('card')) {
      const { left, right } = regionBox(region!);
      const width = Math.min(600, right - left);
      const x = left + (right - left - width) / 2;
      return { left: x, right: x + width, width, top: 300, bottom: 520, height: 220 } as DOMRect;
    }
    return { left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0 } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('card') ? 220 : this.classList.contains('scroll') ? 120 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('card') ? 588 : 0;
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
  vi.useRealTimers();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  setFloat(null);
  dock(false);
  root().removeAttribute(LOG_HELD_ATTR);
  root().removeAttribute(LOG_SETTLING_ATTR);
  document.body.innerHTML = '';
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function card(): HTMLElement {
  const slot = document.querySelector<HTMLElement>('[data-notice-slot="proposal"]')!;
  slot.innerHTML = `<div class="card" data-notice-shrinks="">
    <div class="head"></div><div class="scroll" data-notice-shrink-body=""><div class="body"></div></div><div class="foot" data-notice-shrink-foot=""></div>
  </div>`;
  return slot.firstElementChild as HTMLElement;
}

describe('GM r69 Q3: a drag from the docked log freezes the card\'s sides', () => {
  it('the card\'s rect is constant through the whole drag off the dock, and settles once at the drop', async () => {
    dock(true);
    render(<NoticeRegion screen="home" />);
    const el = card();
    await flush();
    // Beside the docked log: the region ends at its clearance, the card
    // centred in 64-652.
    const rect = () => { const r = el.getBoundingClientRect(); return [r.left, r.right]; };
    const before = rect();
    expect(before).toEqual([64, 652]);
    moves = [];
    // The person picks it up: the hold goes on, then AgentLog finds it off
    // the dock and clears its clearance, and writes its box as floating.
    act(() => { root().setAttribute(LOG_HELD_ATTR, ''); });
    await flush();
    act(() => { dock(false); });
    await flush();
    const trace: number[][] = [];
    for (const left of [600, 520, 420, 300, 180, 80]) {
      act(() => setFloat({ top: 260, bottom: 414, left, right: left + 340 }));
      await flush();
      trace.push(rect());
    }
    // Every frame of the drag: the same rect, and nothing glides.
    expect(trace.every((frame) => frame[0] === before[0] && frame[1] === before[1])).toBe(true);
    expect(moves).toEqual([]);
    // The drop (the log at 80-420): one place, the card off the log, on the spring.
    act(() => { root().removeAttribute(LOG_HELD_ATTR); });
    await flush();
    expect(moves.map((move) => move.element)).toEqual([el]);
    const after = rect();
    expect(after).not.toEqual(before);
    expect(after[0]).toBeGreaterThanOrEqual(420);
    // It settles once: its glide ends, the region places again, nothing more moves.
    act(() => { moves.splice(0).forEach((move) => move.finish()); });
    await flush();
    expect(rect()).toEqual(after);
    expect(moves).toEqual([]);
  });

  it('without the freeze the same drag would move the card mid-drag (the test sees the clearance)', async () => {
    dock(true);
    render(<NoticeRegion screen="home" />);
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    const el = card();
    await flush();
    act(() => { root().setAttribute(LOG_HELD_ATTR, ''); });
    await flush();
    // The freeze is inline: lifting it shows where CSS alone would put the card.
    const frozen = [region.style.left, region.style.right];
    expect(frozen).toEqual(['64px', '372px']);
    act(() => { dock(false); });
    region.style.left = '';
    region.style.right = '';
    expect(el.getBoundingClientRect().left).not.toBe(64);
  });

  it('a floating drag keeps the inset the card had beside the log, and gets it back at the drop', async () => {
    setFloat({ top: 150, bottom: 330, left: 65, right: 405 });
    render(<NoticeRegion screen="home" />);
    const region = document.querySelector<HTMLElement>('[data-notice-region]')!;
    card();
    await flush();
    expect([region.style.left, region.style.right]).toEqual(['413px', '16px']);
    act(() => { root().setAttribute(LOG_HELD_ATTR, ''); });
    await flush();
    expect([region.style.left, region.style.right]).toEqual(['413px', '16px']);
    act(() => { root().removeAttribute(LOG_HELD_ATTR); });
    await flush();
    // Dropped where it was: beside it again.
    expect([region.style.left, region.style.right]).toEqual(['413px', '16px']);
  });
});

describe('GM r69 Q5: at the drop the log stays above the card until its glide rests', () => {
  it('the raise holds from the drop through the glide, and drops back when it rests', async () => {
    setFloat({ top: 150, bottom: 330, left: 65, right: 405 });
    render(<NoticeRegion screen="home" />);
    const el = card();
    await flush();
    act(() => { root().setAttribute(LOG_HELD_ATTR, ''); });
    await flush();
    for (const left of [200, 400, 600]) {
      act(() => setFloat({ top: 150, bottom: 330, left, right: left + 340 }));
      await flush();
    }
    expect(root().hasAttribute(LOG_SETTLING_ATTR)).toBe(false);
    act(() => { root().removeAttribute(LOG_HELD_ATTR); });
    await flush();
    // The card glides away from the log it just left, the log over it.
    expect(moves.map((move) => move.element)).toEqual([el]);
    expect(root().hasAttribute(LOG_SETTLING_ATTR)).toBe(true);
    // A place mid-glide (a resize) lets the glide run on, and the raise with it.
    act(() => { window.dispatchEvent(new Event('resize')); });
    await flush();
    expect(root().hasAttribute(LOG_SETTLING_ATTR)).toBe(true);
    act(() => { moves.splice(0).forEach((move) => move.finish()); });
    await flush();
    expect(root().hasAttribute(LOG_SETTLING_ATTR)).toBe(false);
  });

  it('a drop with nothing to glide drops the raise at once', async () => {
    setFloat({ top: 150, bottom: 330, left: 65, right: 405 });
    render(<NoticeRegion screen="home" />);
    card();
    await flush();
    act(() => { root().setAttribute(LOG_HELD_ATTR, ''); });
    await flush();
    act(() => { root().removeAttribute(LOG_HELD_ATTR); });
    await flush();
    expect(moves).toEqual([]);
    expect(root().hasAttribute(LOG_SETTLING_ATTR)).toBe(false);
  });

  it('a glide whose finish never comes lets the raise go after twice its length', async () => {
    vi.useFakeTimers();
    setFloat({ top: 150, bottom: 330, left: 65, right: 405 });
    render(<NoticeRegion screen="home" />);
    card();
    await flush();
    act(() => { root().setAttribute(LOG_HELD_ATTR, ''); });
    await flush();
    act(() => setFloat({ top: 150, bottom: 330, left: 600, right: 940 }));
    await flush();
    act(() => { root().removeAttribute(LOG_HELD_ATTR); });
    await flush();
    expect(root().hasAttribute(LOG_SETTLING_ATTR)).toBe(true);
    act(() => { vi.advanceTimersByTime(GLIDE_MS * 2 - 1); });
    expect(root().hasAttribute(LOG_SETTLING_ATTR)).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(root().hasAttribute(LOG_SETTLING_ATTR)).toBe(false);
  });
});
