// Review 14 MEDIUM-1 (PR #200 fix round 16): a failed Unicode chunk never
// freezes the tab. The import settles as failed, the strict fallbacks stand
// (every selector, tag run and non-basic chain hidden or counted apart),
// pins apply in that form at once, it is tried once more, and timers still run.
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

describe('review 14 MEDIUM-1: a failed Unicode chunk', () => {
  it('settles as failed; pins apply in the fallback form; one retry; timers still fire', async () => {
    await pins.pinTextReady;
    expect(pins.pinTextSettled()).toBe(true);
    expect(pins.pinTextIsLoaded()).toBe(false);
    let fired = false;
    setTimeout(() => { fired = true; }, 0);
    useCanvasPinsStore.getState().apply({ projectId: 'p1', pins: [pin('pin_a', '葛\u{E0100} ❤️ \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} warmer')] });
    await settle();
    expect(fired).toBe(true);
    expect(useCanvasPinsStore.getState().pins.map((p) => p.id)).toEqual(['pin_a']);
    // Tried once more, never again.
    useCanvasPinsStore.getState().apply({ projectId: 'p1', pins: [pin('pin_b', 'b')] });
    await settle();
    expect(loads.count).toBe(2);
    expect(useCanvasPinsStore.getState().pins.map((p) => p.id)).toEqual(['pin_b']);
    // The strict fallbacks: no selector fits, no tag run is a flag.
    expect(pins.pinDisplayText('葛\u{E0100} ❤️ \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} warmer')).toBe('葛 ❤ \u{1F3F4} warmer');
  });

  it('the note dialog still opens and counts', async () => {
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<PinComposer />);
    await settle();
    expect(screen.getByRole('textbox', { name: 'Note for agents' })).toBeTruthy();
  });
});
