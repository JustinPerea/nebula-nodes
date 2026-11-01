import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { WorkspaceHeader } from '../components/WorkspaceHeader';

// #213 review 1 NIT-6: a studio title cut with an ellipsis gets its full text
// as a tooltip; a whole one gets none.

const widths = { scroll: 120, client: 200 };
let resized: Array<() => void> = [];

beforeEach(() => {
  Object.assign(widths, { scroll: 120, client: 200 });
  resized = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return widths.scroll; } });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return widths.client; } });
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { resized.push(cb); }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

describe('the studio title, cut in a narrow window', () => {
  it('a whole title has no tooltip; cut, its tooltip is the full title; whole again, none', () => {
    render(<WorkspaceHeader title="Moodboard Studio" updatesSlot={false} offlineRow={false} />);
    const title = screen.getByRole('heading', { level: 1 });
    expect(title.hasAttribute('title')).toBe(false);
    act(() => {
      widths.client = 80;
      for (const run of resized) run();
    });
    expect(title.getAttribute('title')).toBe('Moodboard Studio');
    act(() => {
      widths.client = 200;
      for (const run of resized) run();
    });
    expect(title.hasAttribute('title')).toBe(false);
  });
});
