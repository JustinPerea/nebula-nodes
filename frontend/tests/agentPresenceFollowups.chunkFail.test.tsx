// Review 14 MEDIUM-1 (PR #200 fix round 16) and GM r26's check (fix round 17):
// a failed Unicode chunk never freezes the tab. The import settles as failed,
// the strict fallbacks stand (every selector, tag run and non-basic chain
// hidden or counted apart, so the count errs toward refusing), pins apply in
// that form at once, the chunk loads again the next time it's needed (spaced
// out), timers still run, and the person sees no error of their own.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/lib/pinTextUnicode.json', async () => {
  loads.count += 1;
  throw new Error('the chunk failed to load');
});
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));

const pins = await import('../src/lib/canvasPins');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');
const { PinComposer } = await import('../src/components/canvas/PinComposer');

const pin = (id: string, text: string) => ({ id, text, anchor: { nodeId: 'n1' }, status: 'open', createdAt: '2026-10-29T10:00:00+00:00' });
const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((done) => setTimeout(done, 0)); });
afterEach(cleanup);

describe('review 14 MEDIUM-1 + GM r26: a failed Unicode chunk', () => {
  it('settles as failed; pins apply in the fallback form at once; timers still fire', async () => {
    await pins.pinTextReady;
    expect(pins.pinTextSettled()).toBe(true);
    expect(pins.pinTextIsLoaded()).toBe(false);
    let fired = false;
    setTimeout(() => { fired = true; }, 0);
    useCanvasPinsStore.getState().apply({ projectId: 'p1', pins: [pin('pin_a', '葛\u{E0100} ❤️ \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} warmer')] });
    await settle();
    expect(fired).toBe(true);
    expect(useCanvasPinsStore.getState().pins.map((p) => p.id)).toEqual(['pin_a']);
    // The strict fallbacks: no selector fits, no tag run is a flag.
    expect(pins.pinDisplayText('葛\u{E0100} ❤️ \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} warmer')).toBe('葛 ❤ \u{1F3F4} warmer');
  });

  it('GM r26: the counter treats E0100-E01EF as hidden and counts a non-basic chain apart (errs toward refusing)', () => {
    expect(pins.pinTextIsLoaded()).toBe(false);
    for (let selector = 0xe0100; selector <= 0xe01ef; selector += 0x2f) {
      expect(pins.pinDisplayText(`葛${String.fromCodePoint(selector)}`)).toBe('葛');
    }
    expect(pins.noteLength('葛\u{E0100}'.repeat(280))).toBe(280);
    expect(pins.noteLength('葛\u{E0100}'.repeat(281))).toBe(281);
    // A family, one character with the data, counts as each of its people without it.
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(pins.noteLength(family)).toBeGreaterThan(1);
  });

  it('GM r26: loads the chunk again the next time it is needed, at most once per gap', async () => {
    const before = loads.count;
    // Just failed: a burst of needs within the gap fetches nothing.
    pins.retryPinText();
    useCanvasPinsStore.getState().apply({ projectId: 'p1', pins: [pin('pin_b', 'b')] });
    await settle();
    expect(loads.count).toBe(before);
    expect(useCanvasPinsStore.getState().pins.map((p) => p.id)).toEqual(['pin_b']);
    // Needed again after the gap: one more load.
    pins.retryPinText(Date.now() + pins.PIN_TEXT_RETRY_GAP_MS + 1);
    await act(async () => { await pins.pinTextSettling(); });
    expect(loads.count).toBe(before + 1);
    expect(pins.pinTextSettled()).toBe(true);
    // And again the next time after that (not only once per tab).
    pins.retryPinText(Date.now() + pins.PIN_TEXT_RETRY_GAP_MS + 1);
    await act(async () => { await pins.pinTextSettling(); });
    expect(loads.count).toBe(before + 2);
  });

  it('GM r26: the note dialog opens and counts, and the person sees no error of their own', async () => {
    const errors = vi.spyOn(console, 'error');
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<PinComposer />);
    await settle();
    expect(screen.getByRole('textbox', { name: 'Note for agents' })).toBeTruthy();
    expect(useCanvasPinsStore.getState().error).toBeNull();
    expect(document.querySelectorAll('[role="alert"], .canvas-pin-toast--notice, .person-required')).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
