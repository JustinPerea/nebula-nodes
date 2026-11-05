/**
 * PR #204 round 18i (GM r39 1c): media inside a tile or a keyframe tab has no button (a button
 * can't go inside a button), so its line drops "Try again." and reads again by itself: on
 * reconnect, and once each time it scrolls back into view (an IntersectionObserver, no polling,
 * one read per entry). "Try again." always means a button.
 */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

class FakeObserver {
  static all: FakeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) { FakeObserver.all.push(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnected = false;
  disconnect() { this.targets.clear(); this.disconnected = true; }
  takeRecords() { return []; }
  static report(isIntersecting: boolean) {
    for (const observer of FakeObserver.all) {
      const entries = [...observer.targets].map((target) => ({ target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 }) as unknown as IntersectionObserverEntry);
      if (entries.length) observer.callback(entries, observer as unknown as IntersectionObserver);
    }
  }
}

sessionStorage.setItem('nebula.person', JSON.stringify({ token: crypto.randomUUID(), backend: 'http://localhost:8000' }));
const { CommonsMedia } = await import('../src/components/commons/CommonsMedia');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');
const { noteBackendConnection, resetBackendConnectionForTests } = await import('../src/lib/backendConnection');

const state = { ok: false };
const reads = vi.fn();
const NO_ANSWER = 'Nebula couldn’t load this image because the server didn’t respond.';
const line = () => document.querySelector('[data-commons-line]');

beforeEach(() => {
  FakeObserver.all = [];
  state.ok = false;
  reads.mockClear();
  document.body.className = 'app-slava-restraint';
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => {
    reads();
    return state.ok ? new Response('png', { headers: { 'content-type': 'image/png' } })
      : new Response('Service Unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
  }));
});
afterEach(() => { cleanup(); act(() => resetBackendConnectionForTests()); resetLinesForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.className = ''; });

function Tile() {
  return <button type="button" className="commons-tile" onClick={opened}><CommonsMedia inControl path="/api/commons/blobs/a.png" alt="" /></button>;
}
const opened = vi.fn();
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });

it('a tile\'s line ends at its reason: no "Try again.", no button inside the tile', async () => {
  render(<Tile />);
  await waitFor(() => expect(line()?.textContent).toBe(NO_ANSWER));
  expect(document.querySelector('.commons-tile button')).toBeNull();
  // The tile's click keeps its meaning.
  fireEvent.click(document.querySelector('.commons-tile')!);
  expect(opened).toHaveBeenCalledTimes(1);
});

it('scrolling back into view reads again once per entry, not while it stays in view', async () => {
  render(<Tile />);
  await waitFor(() => expect(line()).not.toBeNull());
  expect(reads).toHaveBeenCalledTimes(1);
  // In view from the start: nothing reads.
  act(() => FakeObserver.report(true));
  await settle();
  expect(reads).toHaveBeenCalledTimes(1);
  // Out, then back in: one read.
  act(() => FakeObserver.report(false));
  act(() => FakeObserver.report(true));
  await settle();
  expect(reads).toHaveBeenCalledTimes(2);
  // It failed again, still in view: no loop.
  act(() => FakeObserver.report(true));
  await settle();
  expect(reads).toHaveBeenCalledTimes(2);
  // Out and back in again, now answering: the line goes and the image shows.
  state.ok = true;
  act(() => FakeObserver.report(false));
  act(() => FakeObserver.report(true));
  await waitFor(() => expect(line()).toBeNull());
  expect(reads).toHaveBeenCalledTimes(3);
  expect(document.querySelector('.commons-tile img')).not.toBeNull();
});

it('reconnect reads it again quietly: no stale line back online', async () => {
  render(<Tile />);
  await waitFor(() => expect(line()).not.toBeNull());
  act(() => noteBackendConnection('offline'));
  state.ok = true;
  act(() => noteBackendConnection('online'));
  expect(line()).toBeNull();
  await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(document.querySelector('.commons-tile img')).not.toBeNull());
});

it('media outside a control keeps its Try again button', async () => {
  render(<CommonsMedia path="/api/commons/blobs/a.png" alt="" />);
  await waitFor(() => expect(document.querySelector('.commons-retry')).not.toBeNull());
  expect(line()?.textContent).toBe(`${NO_ANSWER} Try again.`);
  // Its own button reads again: nothing watches it scroll.
  expect([...FakeObserver.all].some((observer) => observer.targets.size > 0)).toBe(false);
});

it('round 18l (review 17 live NIT-2): a reconnect reads each failed tile once, then nothing more', async () => {
  render(<>{[0, 1, 2, 3, 4, 5].map((n) => <Tile key={n} />)}</>);
  await waitFor(() => expect(document.querySelectorAll('[data-commons-line]')).toHaveLength(6));
  expect(reads).toHaveBeenCalledTimes(6);
  act(() => FakeObserver.report(true));
  act(() => noteBackendConnection('offline'));
  act(() => noteBackendConnection('online'));
  await waitFor(() => expect(reads).toHaveBeenCalledTimes(12));
  await waitFor(() => expect(document.querySelectorAll('[data-commons-line]')).toHaveLength(6));
  // Still in view, still failing: no loop, and the observer's own entries add nothing.
  act(() => FakeObserver.report(true));
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await settle();
  expect(reads).toHaveBeenCalledTimes(12);
});

it('round 18l (review 17 logic N19): the tile\'s observer is disconnected on unmount', async () => {
  const { unmount } = render(<Tile />);
  await waitFor(() => expect(line()).not.toBeNull());
  const watching = FakeObserver.all.filter((observer) => observer.targets.size > 0);
  expect(watching).toHaveLength(1);
  unmount();
  expect(watching[0].disconnected).toBe(true);
  expect(watching[0].targets.size).toBe(0);
});
