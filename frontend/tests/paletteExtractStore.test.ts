import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PALETTE_LINE_MIN_MS, PALETTE_PENDING_DELAY_MS, PALETTE_PENDING_TEXT, paletteExtractView, paletteRunKey,
  resetPaletteExtractsForTests, startPaletteExtract,
} from '../src/components/panels/usePaletteExtracts';

// Round 8e of #208: the extract store, outside any Inspector (GM r22 Q2),
// and its own guard (review 8 NIT): a result from an earlier Extract for a
// key that a later one took over never lands, even when it isn't null.

beforeEach(() => {
  vi.useFakeTimers();
  resetPaletteExtractsForTests();
});
afterEach(() => {
  resetPaletteExtractsForTests();
  vi.useRealTimers();
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('the palette extract store', () => {
  it('keys on project, graph generation and node', () => {
    expect(paletteRunKey('pA', 3, 'n1', 'palette')).toBe('pA|3|n1:palette');
    expect(paletteRunKey(null, 0, 'n1', 'palette')).toBe('|0|n1:palette');
  });

  it("drops an earlier Extract's result once a later one started (owner.ticket)", async () => {
    const key = paletteRunKey('pA', 1, 'n1', 'palette');
    const first = deferred<string>();
    const second = deferred<string>();
    const landed: string[] = [];
    startPaletteExtract(key, () => first.promise, (v) => { landed.push(v); return v; });
    startPaletteExtract(key, () => second.promise, (v) => { landed.push(v); return v; });
    // The first answers (not null) after the second started: dropped.
    first.resolve('first');
    await vi.advanceTimersByTimeAsync(0);
    expect(landed).toEqual([]);
    expect(paletteExtractView(key).working).toBe(true);
    second.resolve('second');
    await vi.advanceTimersByTimeAsync(0);
    expect(landed).toEqual(['second']);
    expect(paletteExtractView(key)).toMatchObject({ working: false, status: 'second' });
  });

  it('shows the line after 300 ms and holds it 400 ms', async () => {
    const key = paletteRunKey('pA', 1, 'n1', 'palette');
    const run = deferred<string>();
    startPaletteExtract(key, () => run.promise, (v) => v);
    await vi.advanceTimersByTimeAsync(PALETTE_PENDING_DELAY_MS - 1);
    expect(paletteExtractView(key).shown).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(paletteExtractView(key)).toMatchObject({ shown: true, status: PALETTE_PENDING_TEXT });
    run.resolve('done');
    await vi.advanceTimersByTimeAsync(PALETTE_LINE_MIN_MS - 1);
    expect(paletteExtractView(key).working).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(paletteExtractView(key)).toMatchObject({ working: false, shown: false, status: 'done' });
  });

  it("an older run's held landing never takes the key from a newer pick", async () => {
    const key = paletteRunKey('pA', 1, 'n1', 'palette');
    const first = deferred<string>();
    const second = deferred<string>();
    const landed: string[] = [];
    startPaletteExtract(key, () => first.promise, (v) => { landed.push(v); return v; });
    await vi.advanceTimersByTimeAsync(PALETTE_PENDING_DELAY_MS + 50); // the line shows
    first.resolve('first'); // held for the rest of PALETTE_LINE_MIN_MS
    await vi.advanceTimersByTimeAsync(100);
    startPaletteExtract(key, () => second.promise, (v) => { landed.push(v); return v; });
    await vi.advanceTimersByTimeAsync(PALETTE_LINE_MIN_MS + 100); // past the first's hold
    expect(landed).toEqual([]);
    expect(paletteExtractView(key).working).toBe(true);
    second.resolve('second');
    await vi.advanceTimersByTimeAsync(PALETTE_LINE_MIN_MS + 100);
    expect(landed).toEqual(['second']);
    expect(paletteExtractView(key)).toMatchObject({ working: false, status: 'second' });
  });

  it('a retry shows no line and holds 400 ms from its start', async () => {
    const key = paletteRunKey('pA', 1, 'n1', 'palette');
    startPaletteExtract(key, () => Promise.resolve('again'), (v) => v, { retry: true });
    await vi.advanceTimersByTimeAsync(PALETTE_PENDING_DELAY_MS + 10);
    expect(paletteExtractView(key)).toMatchObject({ working: true, shown: false, status: '' });
    await vi.advanceTimersByTimeAsync(PALETTE_LINE_MIN_MS - PALETTE_PENDING_DELAY_MS - 10);
    expect(paletteExtractView(key)).toMatchObject({ working: false, status: 'again' });
  });
});
