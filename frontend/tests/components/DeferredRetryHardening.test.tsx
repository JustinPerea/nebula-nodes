import { StrictMode, Suspense, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DeferredBoundary } from '../../src/components/DeferredBoundary';
import { lazyWithPreload, type PreloadableComponent } from '../../src/lib/lazyWithPreload';

// The browser side of a chunk retry, and the loops a retry must never start.
//
// Chromium (Chrome and the Electron desktop app) keeps a failed dynamic
// import in its module map: a second import() of the same URL rejects at once
// without touching the network (checked in headless Chrome 147 and 150, for
// offline, an aborted request and an HTTP error). Vite's preload helper also
// skips a stylesheet it already tried. So calling the same loader again
// fetches nothing; a retry has to import the chunk from a fresh URL and add a
// stylesheet that failed again.

type ThingModule = { Thing: ComponentType };
const thingModule: ThingModule = { Thing: () => <p>Loaded thing</p> };
const JS = `${location.origin}/assets/Thing-abc.js`;
const CSS = `${location.origin}/assets/Thing-abc.css`;
const importError = () => new TypeError(`Failed to fetch dynamically imported module: ${JS}`);

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });
const fire = (type: 'online' | 'focus') => act(() => { window.dispatchEvent(new Event(type)); });

function Piece({ chunk, children }: { chunk: PreloadableComponent<object>; children: ReactNode }) {
  return (
    <DeferredBoundary chunk={chunk} failed={<p>Failed</p>}>
      <Suspense fallback={<p>Loading</p>}>{children}</Suspense>
    </DeferredBoundary>
  );
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const maxDepthErrors = () => consoleError.mock.calls.filter((call) => String(call[0]).includes('Maximum update depth')).length;

describe('a retry in a browser that keeps the failed import (Chromium)', () => {
  it('imports the chunk from a fresh URL, once a first attempt has failed', async () => {
    // The loader keeps rejecting, as import() of the same URL does in Chromium.
    const load = vi.fn(() => Promise.reject(importError()));
    const importModule = vi.fn((url: string) => { void url; return Promise.resolve(thingModule); });
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing, { importModule });
    render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    // The first failure is a real one: no second fetch for it.
    expect(importModule).not.toHaveBeenCalled();

    await fire('online');
    expect(await screen.findByText('Loaded thing')).toBeInTheDocument();
    expect(importModule).toHaveBeenCalledTimes(1);
    const url = importModule.mock.calls[0][0];
    expect(url).not.toBe(JS);
    expect(url.startsWith(`${JS}?`)).toBe(true);
  });

  it('adds a stylesheet that failed before the import ran again', async () => {
    // Offline, Vite's helper rejects on the chunk's CSS before it imports the
    // JS, and the JS modulepreload it started failed too.
    let calls = 0;
    const load = vi.fn(() => {
      calls += 1;
      return Promise.reject(calls === 1 ? new Error(`Unable to preload CSS for ${CSS}`) : importError());
    });
    const importModule = vi.fn((url: string) => { void url; return Promise.resolve(thingModule); });
    const loadStyle = vi.fn((url: string) => { void url; return Promise.resolve(); });
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing, { importModule, loadStyle });
    render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();
    expect(screen.getByText('Failed')).toBeInTheDocument();

    await fire('online');
    expect(await screen.findByText('Loaded thing')).toBeInTheDocument();
    expect(loadStyle).toHaveBeenCalledTimes(1);
    expect(loadStyle.mock.calls[0][0].startsWith(`${CSS}?`)).toBe(true);
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it('a fresh URL that fails too waits for the next trigger (no loop)', async () => {
    const load = vi.fn(() => Promise.reject(importError()));
    const importModule = vi.fn((url: string) => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${url}`)));
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing, { importModule });
    render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();

    await fire('online');
    await flush();
    await flush();
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Failed')).toBeInTheDocument();

    await fire('online');
    await flush();
    expect(importModule).toHaveBeenCalledTimes(2);
    // Each attempt uses a URL of its own.
    expect(importModule.mock.calls[1][0]).not.toBe(importModule.mock.calls[0][0]);
  });
});

describe('a retry URL from an error message', () => {
  it('is only fetched when it is one of the app\'s own files', async () => {
    const load = vi.fn(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module: https://elsewhere.test/x.js')));
    const importModule = vi.fn((url: string) => { void url; return Promise.resolve(thingModule); });
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing, { importModule });
    render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();
    await fire('online');
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(importModule).not.toHaveBeenCalled();
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });
});

describe('loops a failed chunk must never start', () => {
  it('keeps listening under StrictMode (its mount is replayed in development)', async () => {
    let fail = true;
    const Thing = lazyWithPreload(() => (fail ? Promise.reject(new Error('chunk failed')) : Promise.resolve(thingModule)), (m: ThingModule) => m.Thing);
    const first = render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();
    first.unmount();

    // Offline, a new mount does not fetch; it waits for 'online'.
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<StrictMode><Piece chunk={Thing}><Thing /></Piece></StrictMode>);
    await flush();
    expect(screen.getByText('Failed')).toBeInTheDocument();

    onLine.mockReturnValue(true);
    fail = false;
    await fire('online');
    expect(await screen.findByText('Loaded thing')).toBeInTheDocument();
  });

  it('does not loop when a loaded piece renders another deferred piece that failed', async () => {
    const innerLoad = vi.fn(() => Promise.reject(new Error('inner chunk failed')));
    const Inner = lazyWithPreload(innerLoad, (m: ThingModule) => m.Thing);
    let outerRenders = 0;
    const Outer = lazyWithPreload(
      () => Promise.resolve({ Thing: () => { outerRenders += 1; return <Inner />; } }),
      (m: ThingModule) => m.Thing,
    );
    await Outer.preload();
    render(<Piece chunk={Outer}><Outer /></Piece>);
    await flush();
    await flush();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(maxDepthErrors()).toBe(0);
    expect(outerRenders).toBeLessThan(10);
    expect(innerLoad.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('never renders a lazy instance that holds an old rejection once the chunk is in', async () => {
    // A caller that preloads again as soon as a preload fails starts the next
    // attempt before the failed lazy instance is marked.
    let left = 1;
    const load = vi.fn(() => {
      if (left > 0) { left -= 1; return Promise.reject(new Error('chunk failed')); }
      return Promise.resolve(thingModule);
    });
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing);
    Thing.preload().catch(() => { void Thing.preload().catch(() => {}); });
    render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();
    await flush();
    expect(maxDepthErrors()).toBe(0);
    expect(await screen.findByText('Loaded thing')).toBeInTheDocument();
  });
});
