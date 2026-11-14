/**
 * The swap marks (lib/cardFallback.ts markSwap / takeSwap, read by
 * components/nodes/withCardSwap.tsx): a card that replaces a fallback frame
 * crossfades over it only when it mounts soon after the hold marked the swap.
 * An off-screen node does not mount when its chunk lands, and a Canvas unmount
 * or a removed node leaves its mark behind, so a later first mount (scrolled
 * into view, an id that returns after an undo) must not crossfade over a card
 * that was never seen as a frame.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeProps } from '@xyflow/react';
import { springLinear, SPRING_SOFT } from '../src/lib/springs';
import { FADE_END_MARGIN_MS, SWAP_WINDOW_MS, markSwap, takeSwap } from '../src/lib/cardFallback';
import { withCardSwap } from '../src/components/nodes/withCardSwap';

let clock = 0;
beforeEach(() => {
  clock = 10_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
});
afterEach(() => {
  cleanup();
  // Marks are module state: drain whatever a test left.
  for (const id of ['a', 'b', 'c', 'old', 'new']) takeSwap(id, clock);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const Card = withCardSwap(() => <div data-testid="card">card</div>);
const props = (id: string) => ({ id, data: {}, selected: false } as unknown as NodeProps);
const ghost = () => document.querySelector('[data-card-fallback="ghost"]');

describe('takeSwap', () => {
  it('reads and deletes: a mark is for one mount', () => {
    markSwap('a');
    expect(takeSwap('a')).toBe(true);
    expect(takeSwap('a')).toBe(false);
  });

  it('does not honour a mark older than the window, and still deletes it', () => {
    markSwap('a');
    clock += SWAP_WINDOW_MS;
    expect(takeSwap('a')).toBe(true);
    markSwap('b');
    clock += SWAP_WINDOW_MS + 1;
    expect(takeSwap('b')).toBe(false);
    expect(takeSwap('b')).toBe(false);
  });

  it('drops stale marks when a new one is added', () => {
    markSwap('old');
    clock += SWAP_WINDOW_MS + 1;
    markSwap('new');
    // The stale mark is gone, not merely refused: a clock that went back does not revive it.
    clock -= 5000;
    expect(takeSwap('old')).toBe(false);
    expect(takeSwap('new')).toBe(true);
  });
});

describe('a card that mounts after a swap was marked', () => {
  it('within the window crossfades over a ghost of its frame', () => {
    markSwap('a');
    clock += 400;
    render(<Card {...props('a')} />);
    expect(ghost()).not.toBeNull();
    expect(document.querySelector('[data-testid="card"]')).not.toBeNull();
  });

  it('that mounts 2 s later (scrolled into view) does not', () => {
    markSwap('a');
    clock += 2000;
    render(<Card {...props('a')} />);
    expect(ghost()).toBeNull();
    expect(document.querySelector('[data-testid="card"]')).not.toBeNull();
  });

  it('a removed node\'s mark does not make the id crossfade when the id returns', () => {
    // The chunk landed, the node never mounted (off screen) and was removed; an undo brings the id back later.
    markSwap('a');
    clock += 4000;
    render(<Card {...props('a')} />);
    expect(ghost()).toBeNull();
  });
});

describe('the ghost\'s timer', () => {
  const reduce = () => vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));

  it('under reduced motion the ghost is still there at 180 ms and gone after the margin', () => {
    reduce();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      markSwap('a');
      render(<Card {...props('a')} />);
      expect(ghost()).not.toBeNull();
      act(() => { vi.advanceTimersByTime(180); });
      expect(ghost()).not.toBeNull();
      act(() => { vi.advanceTimersByTime(FADE_END_MARGIN_MS - 1); });
      expect(ghost()).not.toBeNull();
      act(() => { vi.advanceTimersByTime(1); });
      expect(ghost()).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('on the spring the ghost lasts the spring plus the margin', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const spring = springLinear(SPRING_SOFT).durationMs;
      markSwap('a');
      render(<Card {...props('a')} />);
      act(() => { vi.advanceTimersByTime(spring + FADE_END_MARGIN_MS - 1); });
      expect(ghost()).not.toBeNull();
      act(() => { vi.advanceTimersByTime(1); });
      expect(ghost()).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
