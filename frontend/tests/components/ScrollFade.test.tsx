import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrollFade } from '../../src/components/ScrollFade';

type Geometry = { height: number; contentHeight: number };
let geometry: Geometry;
let resizeObservers: TestResizeObserver[];
let fonts: EventTarget & { ready: Promise<void> };
let previousFonts: PropertyDescriptor | undefined;

class TestResizeObserver {
  targets = new Set<Element>();
  disconnect = vi.fn(() => this.targets.clear());
  constructor(private callback: ResizeObserverCallback) { resizeObservers.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  notify(target: Element) {
    if (!this.targets.has(target)) return;
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

async function settle() {
  // MutationObserver delivery and font readiness use microtasks; measurement
  // may coalesce into the following animation frame.
  await act(async () => {
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    await Promise.resolve();
    vi.runOnlyPendingTimers();
  });
}

async function notifyResize(target: Element) {
  act(() => resizeObservers.forEach((observer) => observer.notify(target)));
  await settle();
}

function viewport() { return screen.getByTestId('viewport'); }
function expectMore(expected: boolean) {
  if (expected) expect(viewport()).toHaveAttribute('data-scroll-more', 'true');
  else expect(viewport()).not.toHaveAttribute('data-scroll-more', 'true');
}

beforeEach(() => {
  vi.useFakeTimers();
  geometry = { height: 200, contentHeight: 400 };
  resizeObservers = [];
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () {
    return this.getAttribute('data-testid') === 'viewport' ? geometry.height : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
    return this.getAttribute('data-testid') === 'viewport' ? geometry.contentHeight : 0;
  });
  previousFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousFonts) Object.defineProperty(document, 'fonts', previousFonts);
  else Reflect.deleteProperty(document, 'fonts');
});

describe('ScrollFade overflow affordance', () => {
  it('shows the bottom fade only when visible content continues below the viewport', async () => {
    render(<ScrollFade data-testid="viewport"><div>Panel contents</div></ScrollFade>);
    await settle();
    expectMore(true);

    geometry.contentHeight = geometry.height;
    await notifyResize(viewport());
    expectMore(false);

    geometry.contentHeight = geometry.height - 20;
    await notifyResize(viewport());
    expectMore(false);
  });

  it('clears at the end and reappears when scrolling back, tolerating one pixel of rounding', async () => {
    render(<ScrollFade data-testid="viewport"><div>Panel contents</div></ScrollFade>);
    await settle();

    viewport().scrollTop = 199;
    fireEvent.scroll(viewport());
    await settle();
    expectMore(false);

    viewport().scrollTop = 198;
    fireEvent.scroll(viewport());
    await settle();
    expectMore(true);

    viewport().scrollTop = 200;
    fireEvent.scroll(viewport());
    await settle();
    expectMore(false);

    viewport().scrollTop = 0;
    fireEvent.scroll(viewport());
    await settle();
    expectMore(true);
  });

  it('does not advertise scrolling while hidden and recalculates when made visible', async () => {
    geometry.height = 0;
    render(<ScrollFade data-testid="viewport"><div>Panel contents</div></ScrollFade>);
    await settle();
    expectMore(false);

    geometry.height = 200;
    await notifyResize(viewport());
    expectMore(true);

    geometry.height = 0;
    await notifyResize(viewport());
    expectMore(false);
  });

  it('updates when content is appended or a section collapses', async () => {
    geometry.contentHeight = 160;
    render(<ScrollFade data-testid="viewport"><div>Panel contents</div></ScrollFade>);
    await settle();
    expectMore(false);

    geometry.contentHeight = 400;
    act(() => viewport().append(document.createElement('section')));
    await settle();
    expectMore(true);

    geometry.contentHeight = 160;
    act(() => viewport().lastElementChild!.remove());
    await settle();
    expectMore(false);
  });

  it('tracks child layout changes that resize content without a DOM mutation', async () => {
    geometry.contentHeight = 160;
    render(<ScrollFade data-testid="viewport"><div data-testid="section">Panel contents</div></ScrollFade>);
    await settle();
    expectMore(false);

    const observedContent = resizeObservers.flatMap((observer) => [...observer.targets])
      .find((target) => target !== viewport() && viewport().contains(target));
    expect(observedContent).toBeDefined();
    geometry.contentHeight = 400;
    await notifyResize(observedContent!);
    expectMore(true);

    geometry.contentHeight = 160;
    await notifyResize(observedContent!);
    expectMore(false);
  });

  it('rechecks after media loads and fonts finish loading', async () => {
    geometry.contentHeight = 160;
    render(<ScrollFade data-testid="viewport"><img alt="Preview" src="/preview.png" /></ScrollFade>);
    await settle();
    expectMore(false);

    geometry.contentHeight = 400;
    fireEvent.load(screen.getByRole('img', { name: 'Preview' }));
    await settle();
    expectMore(true);

    geometry.contentHeight = 160;
    act(() => fonts.dispatchEvent(new Event('loadingdone')));
    await settle();
    expectMore(false);
  });

  it('rechecks available height when the window resizes', async () => {
    render(<ScrollFade data-testid="viewport"><div>Panel contents</div></ScrollFade>);
    await settle();
    expectMore(true);

    geometry.height = 420;
    fireEvent(window, new Event('resize'));
    await settle();
    expectMore(false);
  });

  it('retains div attributes, caller scroll events and the actual scrollable ref', async () => {
    const ref = createRef<HTMLDivElement>();
    const onScroll = vi.fn();
    render(<ScrollFade ref={ref} data-testid="viewport" className="existing-panel"
      role="region" aria-label="Model options" tabIndex={0} onScroll={onScroll}>
      <input aria-label="Prompt" />
    </ScrollFade>);
    await settle();
    expect(ref.current).toBe(viewport());
    expect(viewport()).toHaveClass('existing-panel');
    expect(screen.getByRole('region', { name: 'Model options' })).toBe(viewport());
    expect(viewport()).toHaveAttribute('tabindex', '0');

    ref.current!.scrollTop = 200;
    fireEvent.scroll(ref.current!);
    await settle();
    expect(onScroll).toHaveBeenCalledOnce();
    expectMore(false);
  });

  it('preserves list semantics and ref access for list-based panels', async () => {
    const ref = createRef<HTMLUListElement>();
    render(<ScrollFade as="ul" ref={ref} data-testid="viewport" aria-label="Compatible models">
      <li>Image edit</li><li>Video model</li>
    </ScrollFade>);
    await settle();
    expect(screen.getByRole('list', { name: 'Compatible models' })).toBe(viewport());
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(ref.current).toBe(viewport());
    expectMore(true);
  });

  it('continues updating from scroll and content mutations when ResizeObserver is unavailable', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    geometry.contentHeight = 160;
    render(<ScrollFade data-testid="viewport"><div>Panel contents</div></ScrollFade>);
    await settle();
    expectMore(false);

    geometry.contentHeight = 400;
    act(() => viewport().append(document.createElement('section')));
    await settle();
    expectMore(true);

    viewport().scrollTop = 200;
    fireEvent.scroll(viewport());
    await settle();
    expectMore(false);
  });

  it('keeps focused controls mounted during overflow and content changes', async () => {
    const { rerender } = render(<ScrollFade data-testid="viewport"><input aria-label="Prompt" /></ScrollFade>);
    await settle();
    const prompt = screen.getByRole('textbox', { name: 'Prompt' });
    act(() => prompt.focus());

    geometry.contentHeight = 160;
    await notifyResize(viewport());
    expectMore(false);
    expect(prompt).toHaveFocus();

    geometry.contentHeight = 400;
    rerender(<ScrollFade data-testid="viewport"><input aria-label="Prompt" /><div>More options</div></ScrollFade>);
    await settle();
    expectMore(true);
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toBe(prompt);
    expect(prompt).toHaveFocus();
  });

  it('disconnects observers and removes window, media and font listeners on unmount', async () => {
    const mutationDisconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const windowRemove = vi.spyOn(window, 'removeEventListener');
    const fontRemove = vi.spyOn(fonts, 'removeEventListener');
    const callbackRef = vi.fn();
    const { unmount } = render(<ScrollFade ref={callbackRef} data-testid="viewport"><div>Panel contents</div></ScrollFade>);
    await settle();
    const element = viewport();
    const elementRemove = vi.spyOn(element, 'removeEventListener');
    expect(callbackRef).toHaveBeenCalledWith(element);
    expect(resizeObservers.length).toBeGreaterThan(0);

    // Leave a pending measurement to exercise cancellation as well as cleanup.
    fireEvent.scroll(element);
    unmount();
    await settle();
    expect(callbackRef).toHaveBeenLastCalledWith(null);
    expect(resizeObservers.every((observer) => observer.disconnect.mock.calls.length > 0)).toBe(true);
    expect(mutationDisconnect).toHaveBeenCalled();
    expect(windowRemove.mock.calls.some(([event]) => event === 'resize')).toBe(true);
    expect(fontRemove.mock.calls.some(([event]) => event === 'loadingdone')).toBe(true);
    expect(elementRemove.mock.calls.some(([event]) => event === 'load')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
