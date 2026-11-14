import { describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';
import { lazyWithPreload } from '../../src/lib/lazyWithPreload';

// isSettled and onSettle are what the canvas's hold waits on (lib/cardHold.ts):
// settled is loaded, or the last attempt failed and none is running; the
// listener fires when an attempt ends, loaded or failed.

type Mod = { Thing: ComponentType };
const mod: Mod = { Thing: () => null };

/** A loader whose attempts the test ends one by one. */
function controlled() {
  const attempts: Array<{ resolve: () => void; reject: () => void }> = [];
  const load = vi.fn(() => new Promise<Mod>((resolve, reject) => {
    attempts.push({ resolve: () => resolve(mod), reject: () => reject(new Error('chunk failed')) });
  }));
  return { load, attempts, chunk: lazyWithPreload(load, (m: Mod) => m.Thing) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('isSettled', () => {
  it('is false before any attempt and while the first one is running', async () => {
    const { chunk, attempts } = controlled();
    expect(chunk.isSettled()).toBe(false);
    const preloading = chunk.preload();
    expect(chunk.isSettled()).toBe(false);
    attempts[0].resolve();
    await preloading;
  });

  it('is true once loaded', async () => {
    const { chunk, attempts } = controlled();
    const preloading = chunk.preload();
    attempts[0].resolve();
    await preloading;
    expect(chunk.isLoaded()).toBe(true);
    expect(chunk.isSettled()).toBe(true);
  });

  it('is true after a failure with no attempt running, and false while a retry is in flight', async () => {
    const { chunk, attempts } = controlled();
    const first = chunk.preload();
    attempts[0].reject();
    await expect(first).rejects.toThrow('chunk failed');
    expect(chunk.isLoaded()).toBe(false);
    expect(chunk.isSettled()).toBe(true);

    const retry = chunk.retry('intent');
    await tick();
    expect(attempts).toHaveLength(2);
    expect(chunk.isSettled()).toBe(false);
    attempts[1].resolve();
    await retry;
    expect(chunk.isSettled()).toBe(true);
  });
});

describe('onSettle', () => {
  it('fires once per attempt end, for a failure and for a success, and not after it unsubscribes', async () => {
    const { chunk, attempts } = controlled();
    const listener = vi.fn();
    const off = chunk.onSettle(listener);

    const first = chunk.preload();
    expect(listener).not.toHaveBeenCalled();
    attempts[0].reject();
    await expect(first).rejects.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);

    const second = chunk.retry('intent');
    await tick();
    // Starting an attempt is not an end.
    expect(listener).toHaveBeenCalledTimes(1);
    // A second caller joins the attempt in flight: still one end.
    const joined = chunk.preload();
    attempts[1].resolve();
    await Promise.all([second, joined]);
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    // Loaded already: nothing more to end, and an unsubscribed listener hears none.
    await chunk.preload();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('an unsubscribed listener hears no later attempt end', async () => {
    const { chunk, attempts } = controlled();
    const listener = vi.fn();
    const off = chunk.onSettle(listener);
    off();
    const first = chunk.preload();
    attempts[0].reject();
    await expect(first).rejects.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });
});
