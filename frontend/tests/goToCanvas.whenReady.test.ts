import { afterEach, describe, expect, it, vi } from 'vitest';
import { whenReady } from '../src/lib/goToCanvas';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('whenReady', () => {
  it('resolves true once ready holds for two frames', async () => {
    vi.useFakeTimers();
    const result = whenReady(() => true);
    await vi.advanceTimersByTimeAsync(32);
    await expect(result).resolves.toBe(true);
  });

  it('resolves false after the timeout', async () => {
    vi.useFakeTimers();
    const result = whenReady(() => false, 100);
    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toBe(false);
  });

  // A test that ends mid-wait tears its window down while a poll is queued
  // (CI on #186: "window is not defined" from AgentNotesEveryScreen).
  it('stops quietly when the page is gone mid-wait', async () => {
    vi.useFakeTimers();
    let settled = false;
    void whenReady(() => false).then(() => { settled = true; });
    vi.stubGlobal('window', undefined);
    expect(() => vi.advanceTimersByTime(64)).not.toThrow();
    await Promise.resolve();
    expect(settled).toBe(false);
  });
});
