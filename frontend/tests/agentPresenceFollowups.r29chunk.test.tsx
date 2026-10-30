// PR #200 fix round 19, review 16 NIT 2: when the Unicode chunk loads because
// the note dialog opened (after an earlier failure), the pins already on
// screen redraw in the full form at once, not at the next pins push.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const chunk = vi.hoisted(() => ({ fail: true, loads: 0 }));
vi.mock('../src/lib/pinTextUnicode.json', async (importOriginal) => {
  chunk.loads += 1;
  if (chunk.fail) throw new Error('the chunk failed to load');
  return importOriginal();
});
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));

const pins = await import('../src/lib/canvasPins');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');

/** The cards' text as PinLayer draws it (pinDisplayText of each stored pin). */
function Cards() {
  const list = useCanvasPinsStore((s) => s.pins);
  return <ul>{list.map((pin) => <li key={pin.id} data-testid={pin.id}>{pins.pinDisplayText(pin.text)}</li>)}</ul>;
}
const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((done) => setTimeout(done, 0)); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('review 16 NIT 2: the chunk loaded by the dialog opening redraws the cards on screen', () => {
  it('fallback form while it failed; the full form as soon as the dialog\'s opening loads it, with no pins push', async () => {
    await pins.pinTextReady;
    expect(pins.pinTextIsLoaded()).toBe(false);
    useCanvasPinsStore.getState().apply({ projectId: 'p1',
      pins: [{ id: 'pin_a', text: '葛\u{E0100} first ❤️', anchor: { nodeId: 'n1' }, status: 'open', createdAt: '2026-10-29T10:00:00+00:00' }] });
    render(<Cards />);
    await settle();
    expect(screen.getByTestId('pin_a').textContent).toBe('葛 first ❤');
    // The chunk is reachable again; the retry gap has passed; the dialog opens (a need).
    chunk.fail = false;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + pins.PIN_TEXT_RETRY_GAP_MS + 1000);
    const before = chunk.loads;
    act(() => { useCanvasPinsStore.getState().compose({ nodeId: 'n1' }); });
    await act(async () => { await pins.pinTextSettling(); });
    await settle();
    expect(chunk.loads).toBe(before + 1);
    expect(pins.pinTextIsLoaded()).toBe(true);
    expect(screen.getByTestId('pin_a').textContent).toBe('葛\u{E0100} first ❤️');
  });
});
