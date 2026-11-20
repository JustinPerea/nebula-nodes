import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFERRED_CARD_PRELOADS } from '../../src/lib/deferredChunks';
import shared from '../../../backend/tests/fixtures/jev_outputs.json';
import type { PortValue } from '../../src/types';
import { JevResultView } from '../../src/components/nodes/JevResult';
import { JEV_DECIDE, parseJevOutputs, type JevResult } from '../../src/lib/jev';

type Sample = { name: string; params?: Record<string, unknown>; outputs: Record<string, PortValue> };
const decide = (shared as unknown as { decide: Sample[] }).decide;
const parse = (name: string) => {
  const s = decide.find((d) => d.name.includes(name));
  if (!s) throw new Error(`no fixture sample "${name}"`);
  return { result: parseJevOutputs(JEV_DECIDE, s.outputs) as JevResult, params: s.params ?? {} };
};

const OPEN = '“';
const CLOSE = '”';

let capacity = 40;
let observers: { callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = [];
let lineHeight = '20px';

beforeAll(async () => { await Promise.all(DEFERRED_CARD_PRELOADS.map((preload) => preload())); });

beforeEach(() => {
  capacity = 40;
  lineHeight = '20px';
  observers = [];
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn();
    constructor(callback: ResizeObserverCallback) { observers.push({ callback, disconnect: this.disconnect }); }
    observe() {}
    unobserve() {}
  });
  vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ lineHeight }) as CSSStyleDeclaration);
  // A paragraph that holds `capacity` characters a line: its height follows the visible text.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    const visible = this.querySelector('[data-testid="jev-asked-visible"]');
    return Math.ceil((visible?.textContent?.length ?? 0) / capacity) * 20;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const view = (name: string, fieldText: string | null = 'something else') => {
  const { result, params } = parse(name);
  return <JevResultView result={result} params={params} fieldText={fieldText} />;
};
const visible = () => screen.getByTestId('jev-asked-visible');
const observer = () => observers[observers.length - 1];
const resize = (width: number) => act(() => {
  observer().callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
});
/** What React rendered for the visible text, which the DOM must still match. */
const shownText = () => visible().querySelector('span:last-child')?.textContent;
const SHORT = 'yes/no that passes';
const LONG = 'longer than the report line';

describe('the quoted question fit, observer path', () => {
  it('sets data-fit once measured and cuts to two lines', () => {
    render(view(LONG));
    expect(screen.getByTestId('jev-asked')).toHaveAttribute('data-fit');
    expect(visible().textContent!.length).toBeLessThanOrEqual(80 + 20);
    expect(visible().textContent).toMatch(new RegExp(`…${CLOSE}$`));
  });

  it('leaves the whole text and the clamp alone when it fits', () => {
    render(view(SHORT));
    expect(visible().textContent).toBe(`Asked ${OPEN}Is the product on a plain white background?${CLOSE}`);
  });

  it('re-cuts when the width changes, and not when only the height does', () => {
    render(view(LONG));
    const wide = visible().textContent;
    capacity = 20;
    resize(300);
    const narrow = visible().textContent;
    expect(narrow!.length).toBeLessThan(wide!.length);
    expect(shownText()).toBe(narrow!.slice('Asked “'.length, -1));
    // Same width again (our own cut changes only the height): no new measure.
    capacity = 10;
    resize(300);
    expect(visible().textContent).toBe(narrow);
  });

  it('shows the cut of the new text when the text changes after a cut', () => {
    const { rerender } = render(view(LONG));
    const before = visible().textContent;
    rerender(view(SHORT));
    expect(visible().textContent).toBe(`Asked ${OPEN}Is the product on a plain white background?${CLOSE}`);
    rerender(view(LONG));
    expect(visible().textContent).toBe(before);
    expect(shownText()).toBe(before!.slice('Asked “'.length, -1));
  });

  it('re-measures when the text goes away and comes back', () => {
    const full = parse(SHORT);
    const same = 'Is the product on a plain white background?';
    const { rerender } = render(view(LONG));
    rerender(<JevResultView result={full.result} params={full.params} fieldText={same} />);
    expect(screen.queryByTestId('jev-asked')).not.toBeInTheDocument();
    capacity = 20;
    rerender(view(LONG));
    expect(screen.getByTestId('jev-asked')).toHaveAttribute('data-fit');
    expect(visible().textContent!.length).toBeLessThanOrEqual(40 + 20);
    expect(shownText()).toBe(visible().textContent!.slice('Asked “'.length, -1));
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = render(view(LONG));
    const current = observer();
    unmount();
    expect(current.disconnect).toHaveBeenCalled();
  });

  it('keeps the visible text equal to what React rendered under StrictMode', () => {
    render(<StrictMode>{view(LONG)}</StrictMode>);
    const first = visible().textContent;
    expect(first).toMatch(new RegExp(`…${CLOSE}$`));
    expect(shownText()).toBe(first!.slice('Asked “'.length, -1));
    capacity = 20;
    resize(250);
    expect(visible().textContent!.length).toBeLessThan(first!.length);
    expect(shownText()).toBe(visible().textContent!.slice('Asked “'.length, -1));
  });

  it('leaves data-fit off when there is no usable line-height, so the base clamp applies', () => {
    lineHeight = 'normal';
    render(view(LONG));
    const asked = screen.getByTestId('jev-asked');
    expect(asked).not.toHaveAttribute('data-fit');
    expect(visible().textContent).toContain('…');
    expect(visible().textContent).toBe(`Asked ${OPEN}${asked.title.slice(1, -1)}${CLOSE}`);
  });
});
