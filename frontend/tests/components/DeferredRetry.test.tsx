import { Suspense, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DeferredBoundary } from '../../src/components/DeferredBoundary';
import { lazyWithPreload } from '../../src/lib/lazyWithPreload';

// A deferred chunk that failed to load (web build replaced under an open tab,
// offline) must load again without a reload: on the next intent to open it,
// when the network comes back, or when the window regains focus. React.lazy
// keeps a rejection forever, so lazyWithPreload swaps in a fresh lazy
// component after one, and DeferredBoundary clears its error once the chunk
// is in. A failure must never turn into a loop or a fetch storm.

type ThingModule = { Thing: ComponentType };
const thingModule: ThingModule = { Thing: () => <p>Loaded thing</p> };

/** A loader that rejects `failures` times, then resolves. */
function flakyLoad(failures: number) {
  let left = failures;
  return vi.fn(() => {
    if (left > 0) {
      left -= 1;
      return Promise.reject(new Error('chunk failed'));
    }
    return Promise.resolve(thingModule);
  });
}

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });
const fire = (type: 'online' | 'focus') => act(() => { window.dispatchEvent(new Event(type)); });

const fallbackRendered = vi.fn();
function Fallback() {
  fallbackRendered();
  return <p>Loading</p>;
}

function Piece({ chunk, retryKey, children }: { chunk: ReturnType<typeof lazyWithPreload<ThingModule, object>>; retryKey?: unknown; children: ReactNode }) {
  return (
    <DeferredBoundary chunk={chunk} retryKey={retryKey} failed={<p>Failed</p>}>
      <Suspense fallback={<Fallback />}>{children}</Suspense>
    </DeferredBoundary>
  );
}

beforeEach(() => {
  fallbackRendered.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a deferred chunk that rejects once, then loads', () => {
  it('renders after the window comes back online, without a reload', async () => {
    const load = flakyLoad(1);
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing);
    render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();
    expect(screen.getByText('Failed')).toBeInTheDocument();

    await fire('online');
    expect(await screen.findByText('Loaded thing')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('renders after the window regains focus', async () => {
    const load = flakyLoad(1);
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing);
    render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();
    expect(screen.getByText('Failed')).toBeInTheDocument();

    await fire('focus');
    expect(await screen.findByText('Loaded thing')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('renders on the next intent to open it (a new retry key)', async () => {
    const load = flakyLoad(1);
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing);
    const { rerender } = render(<Piece chunk={Thing} retryKey={1}><Thing /></Piece>);
    await flush();
    expect(screen.getByText('Failed')).toBeInTheDocument();

    rerender(<Piece chunk={Thing} retryKey={2}><Thing /></Piece>);
    expect(await screen.findByText('Loaded thing')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('renders on a fresh mount after a failed one (React.lazy keeps no stale rejection)', async () => {
    const load = flakyLoad(1);
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing);
    const first = render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    first.unmount();

    render(<Piece chunk={Thing}><Thing /></Piece>);
    expect(await screen.findByText('Loaded thing')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shows no loading fallback when it recovers: the chunk is in before the piece renders again', async () => {
    const Thing = lazyWithPreload(flakyLoad(1), (m: ThingModule) => m.Thing);
    render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();
    const before = fallbackRendered.mock.calls.length;

    await fire('online');
    await screen.findByText('Loaded thing');
    expect(fallbackRendered).toHaveBeenCalledTimes(before);
  });

  it('recovers every piece that shares the chunk, with one fetch', async () => {
    const load = flakyLoad(1);
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing);
    render(<div><Piece chunk={Thing}><Thing /></Piece><Piece chunk={Thing}><Thing /></Piece></div>);
    await flush();
    expect(screen.getAllByText('Failed')).toHaveLength(2);

    await fire('online');
    await flush();
    expect(screen.getAllByText('Loaded thing')).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('recovers when another caller (an idle or hover preload) brings the chunk in', async () => {
    const Thing = lazyWithPreload(flakyLoad(1), (m: ThingModule) => m.Thing);
    render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();
    expect(screen.getByText('Failed')).toBeInTheDocument();

    await act(async () => { await Thing.preload(); });
    expect(await screen.findByText('Loaded thing')).toBeInTheDocument();
  });
});

describe('a chunk that keeps failing', () => {
  it('never retries on its own: one fetch per trigger, none in between', async () => {
    const load = vi.fn(() => Promise.reject(new Error('gone')));
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing);
    const { rerender } = render(<Piece chunk={Thing} retryKey={1}><Thing /></Piece>);
    await flush();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);

    await fire('online');
    await flush();
    expect(load).toHaveBeenCalledTimes(2);

    rerender(<Piece chunk={Thing} retryKey={2}><Thing /></Piece>);
    await flush();
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('does not refetch on every focus: focus retries are spaced out', async () => {
    const load = vi.fn(() => Promise.reject(new Error('gone')));
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing);
    render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();

    for (let i = 0; i < 5; i += 1) {
      await fire('focus');
      await flush();
    }
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('does not fetch on focus while the browser is offline', async () => {
    const load = flakyLoad(1);
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing);
    render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    await fire('focus');
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Failed')).toBeInTheDocument();

    // A node card remounting while offline does not fetch either.
    render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Failed')).toHaveLength(2);

    onLine.mockReturnValue(true);
    await fire('online');
    await flush();
    expect(screen.getAllByText('Loaded thing')).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not retry an error thrown by the loaded component itself', async () => {
    let renders = 0;
    const Broken = () => {
      renders += 1;
      throw new Error('render bug');
    };
    const load = vi.fn(() => Promise.resolve({ Thing: Broken }));
    const Thing = lazyWithPreload(load, (m: ThingModule) => m.Thing);
    await Thing.preload();
    render(<Piece chunk={Thing}><Thing /></Piece>);
    await flush();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    const rendersAfterFailure = renders;

    await fire('online');
    await fire('focus');
    await flush();
    expect(renders).toBe(rendersAfterFailure);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
