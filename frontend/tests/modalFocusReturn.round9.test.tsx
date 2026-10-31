/**
 * Review 8 of PR #203, copy NIT-2 and NIT-3 (mutants M18 and M19): the two
 * halves of a dialog's focus return, each pinned.
 * - isReturningFocus: while a dialog's close puts focus back on its opener,
 *   a focus trap that is still listening (a comparison or the onboarding
 *   overlay under it) lets that one move through instead of pulling focus
 *   back inside. Any other focus that leaves the trap is still pulled back.
 * - focusVisible: the return asks for a visible ring wherever the close came
 *   from (GM, PR #203 r15 item 4). jsdom draws no ring, so the option is
 *   read off the focus call.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultComparison, type ComparisonResult } from '../src/components/create-studio/ResultComparison';
import { isReturningFocus, returnFocusTo } from '../src/lib/modalFocus';

function pair(): [ComparisonResult, ComparisonResult] {
  return [1, 2].map((index) => ({
    key: `run-${index}:n${index}`,
    nodeId: `n${index}`,
    media: { url: `/api/outputs/synthetic-${index}.png`, kind: 'image' },
    context: { key: `run-${index}:n${index}`, modelName: `Model ${index}`, definitionId: 'nano-banana', prompt: `Prompt ${index}`,
      timestamp: Date.UTC(2026, 9, 30, 12, index), provenance: 'saved-run', params: {}, refs: [], runId: `run-${index}` },
  })) as unknown as [ComparisonResult, ComparisonResult];
}

let outside: HTMLButtonElement;

beforeEach(() => {
  outside = document.createElement('button');
  outside.textContent = 'Outside the comparison';
  document.body.append(outside);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  outside.remove();
  document.body.classList.remove('result-comparison-open');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a dialog\'s focus return passes a trap that is still listening (NIT-2, M18)', () => {
  it('the comparison pulls ordinary focus back, but not the return', () => {
    render(<ResultComparison items={pair()} onClose={() => {}} />);
    const close = screen.getByRole('button', { name: /close/i });
    expect(close).toHaveFocus();
    // Focus leaving on its own is a slip: the trap brings it back.
    outside.focus();
    expect(close).toHaveFocus();
    // A closing dialog's return is not: it lands where it was sent.
    returnFocusTo(outside);
    expect(outside).toHaveFocus();
  });

  it('is set only while the return moves focus', () => {
    const seen: boolean[] = [];
    outside.addEventListener('focus', () => seen.push(isReturningFocus()));
    expect(isReturningFocus()).toBe(false);
    returnFocusTo(outside);
    expect(seen).toEqual([true]);
    expect(isReturningFocus()).toBe(false);
  });

  it('is cleared even when the focus call throws', () => {
    const broken = document.createElement('button');
    broken.focus = () => { throw new Error('gone'); };
    expect(() => returnFocusTo(broken)).toThrow('gone');
    expect(isReturningFocus()).toBe(false);
  });
});

describe('the return asks for a visible ring (NIT-3, M19)', () => {
  it('focuses with focusVisible and without scrolling', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    returnFocusTo(outside);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus.mock.contexts[0]).toBe(outside);
    expect(focus.mock.calls[0][0]).toEqual({ preventScroll: true, focusVisible: true });
  });
});
