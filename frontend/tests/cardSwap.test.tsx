/**
 * The swap marks (lib/cardFallback.ts markSwap / takeSwap, read by
 * components/nodes/withCardSwap.tsx): a card that replaces a fallback frame
 * crossfades over it only when it mounts soon after the hold marked the swap.
 * An off-screen node does not mount when its chunk lands, and a Canvas unmount
 * or a removed node leaves its mark behind, so a later first mount (scrolled
 * into view, an id that returns after an undo) must not crossfade over a card
 * that was never seen as a frame.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeProps } from '@xyflow/react';
import { SWAP_WINDOW_MS, markSwap, takeSwap } from '../src/lib/cardFallback';
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
