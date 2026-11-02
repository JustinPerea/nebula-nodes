import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { useScrollPanel } from './useScrollPanel';
import { BoardSidePanel } from '../components/moodboard-studio/BoardSidePanel';

// #213 round 3 (review 1 NIT-4, NIT-5): the Board view's side panel under the
// board scrolls inside itself; beside it (970 px and up) it usually doesn't.

const box = { scrollHeight: 900, clientHeight: 300 };
let resized: Array<() => void> = [];

function Panel() {
  const ref = useRef<HTMLDivElement>(null);
  const scrolls = useScrollPanel(ref);
  return <div ref={ref} data-testid="panel" tabIndex={scrolls ? 0 : undefined}><p>Board</p></div>;
}

beforeEach(() => {
  Object.assign(box, { scrollHeight: 900, clientHeight: 300 });
  resized = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return box.scrollHeight; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return box.clientHeight; } });
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { resized.push(cb); }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

/** The panel changes size: the browser lays it out (and clamps scrollTop to what it can reach, 0 where nothing overflows), then the observer runs. */
const resize = (panel: HTMLElement, clientHeight: number) => act(() => {
  box.clientHeight = clientHeight;
  const reach = Math.max(0, box.scrollHeight - clientHeight);
  if (panel.scrollTop > reach) {
    panel.scrollTop = reach;
    fireEvent.scroll(panel);
  }
  for (const run of resized) run();
});
/** The person scrolls the panel. */
const scrollTo = (panel: HTMLElement, top: number) => act(() => {
  panel.scrollTop = top;
  fireEvent.scroll(panel);
});

describe('a panel that scrolls only at some sizes', () => {
  it('is a tab stop while its content overflows, and not otherwise', () => {
    const { getByTestId } = render(<Panel />);
    const panel = getByTestId('panel');
    expect(panel.tabIndex).toBe(0);
    resize(panel, 1000);
    expect(panel.hasAttribute('tabindex')).toBe(false);
    resize(panel, 300);
    expect(panel.tabIndex).toBe(0);
  });

  it('keeps its scroll position across a size where nothing overflows (the 970 px crossing and back)', () => {
    const { getByTestId } = render(<Panel />);
    const panel = getByTestId('panel');
    act(() => {
      panel.scrollTop = 120;
      fireEvent.scroll(panel);
    });
    resize(panel, 1000); // beside the board: the browser drops it to 0
    expect(panel.scrollTop).toBe(0);
    resize(panel, 300); // under it again
    expect(panel.scrollTop).toBe(120);
  });

  it('a scroll back to the top is kept as the top', () => {
    const { getByTestId } = render(<Panel />);
    const panel = getByTestId('panel');
    act(() => {
      panel.scrollTop = 120;
      fireEvent.scroll(panel);
      panel.scrollTop = 0;
      fireEvent.scroll(panel);
    });
    resize(panel, 1000);
    resize(panel, 300);
    expect(panel.scrollTop).toBe(0);
  });
});

describe('the person\'s scroll is the intent (#213 round 3c)', () => {
  it('120, then a short layout that reaches only 55: it sits at 55, and goes back to 120 when it can', () => {
    const { getByTestId } = render(<Panel />);
    const panel = getByTestId('panel');
    scrollTo(panel, 120);
    resize(panel, 845); // 900 - 845: reaches 55
    expect(panel.scrollTop).toBe(55);
    resize(panel, 300);
    expect(panel.scrollTop).toBe(120);
  });

  it('across the 970 crossing, then a short layout, then back: 0, 55, 120', () => {
    const { getByTestId } = render(<Panel />);
    const panel = getByTestId('panel');
    scrollTo(panel, 120);
    resize(panel, 1000);
    expect(panel.scrollTop).toBe(0);
    resize(panel, 845);
    expect(panel.scrollTop).toBe(55);
    resize(panel, 300);
    expect(panel.scrollTop).toBe(120);
  });

  it('a scroll to 30 while it sits at 55 is the new intent: back at full size it stays at 30', () => {
    const { getByTestId } = render(<Panel />);
    const panel = getByTestId('panel');
    scrollTo(panel, 120);
    resize(panel, 845);
    scrollTo(panel, 30);
    expect(panel.scrollTop).toBe(30);
    resize(panel, 300);
    expect(panel.scrollTop).toBe(30);
  });

  it('a scroll to the end while it is short is kept as that position', () => {
    const { getByTestId } = render(<Panel />);
    const panel = getByTestId('panel');
    scrollTo(panel, 20);
    resize(panel, 845);
    scrollTo(panel, 55);
    resize(panel, 300);
    expect(panel.scrollTop).toBe(55);
  });

  it('content that grows keeps the position; content added while short can bring it back', () => {
    const { getByTestId } = render(<Panel />);
    const panel = getByTestId('panel');
    scrollTo(panel, 120);
    resize(panel, 845);
    expect(panel.scrollTop).toBe(55);
    act(() => {
      box.scrollHeight = 1000; // a note's field grows: now reaches 155
      for (const run of resized) run();
    });
    expect(panel.scrollTop).toBe(120);
  });
});

describe('the Board view\'s side panel uses it', () => {
  it('is a tab stop while it scrolls, and not once it fits', () => {
    const { container } = render(
      <BoardSidePanel images={[]} selected={[]} analysis={null} onUpdate={vi.fn()} onRemove={vi.fn()} onTextDone={vi.fn()}>{null}</BoardSidePanel>,
    );
    const panel = container.querySelector<HTMLElement>('.moodboard-board-panel')!;
    expect(panel.tabIndex).toBe(0);
    resize(panel, 1000);
    expect(panel.hasAttribute('tabindex')).toBe(false);
  });
});
