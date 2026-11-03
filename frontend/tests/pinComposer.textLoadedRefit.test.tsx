// PR #218 review 1 LOW-1: the Unicode chunk failed at startup, so PinComposer
// was already counting with the strict fallbacks. The dialog opening loads it
// again; when it lands, the open dialog's "N left" and the kept-note notices
// redraw in the full form at once, with no keystroke and no store change.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const chunk = vi.hoisted(() => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  return { fail: true, gate, release: () => release() };
});
vi.mock('../src/lib/pinTextUnicode.json', async (importOriginal) => {
  if (chunk.fail) throw new Error('the chunk failed to load');
  await chunk.gate;
  return importOriginal();
});
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));

const pins = await import('../src/lib/canvasPins');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');
const { PinComposer } = await import('../src/components/canvas/PinComposer');

const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((done) => setTimeout(done, 0)); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

// A family (one character with the data, its three people without it) after
// 250 letters: 29 left in the full form, 27 in the fallback's.
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
const DRAFT = 'a'.repeat(250) + FAMILY;
// A registered ideographic variant and an emoji heart: the fallback hides both selectors.
const KEPT_TEXT = '葛\u{E0100} ❤️';

describe('PR #218 review 1 LOW-1: the chunk loaded again refits what PinComposer shows', () => {
  it('"N left" and the kept note go from the fallback form to the full form when the retried chunk lands', async () => {
    await pins.pinTextReady;
    expect(pins.pinTextIsLoaded()).toBe(false);
    useCanvasPinsStore.setState({
      drafts: { '': DRAFT },
      kept: [{ text: KEPT_TEXT, project: 'p-other', projectName: 'Other', following: null, line: pins.noteKeptLine(null) }],
    });
    // Mounted after the failure: it counts at once, in the fallback form.
    render(<PinComposer />);
    await settle();
    const keptNote = () => document.querySelector('.canvas-pin-toast__note')?.textContent;
    expect(keptNote()).toBe('葛 ❤');
    // The chunk is reachable again but slow; the retry gap has passed; the dialog opens (a need).
    chunk.fail = false;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + pins.PIN_TEXT_RETRY_GAP_MS + 1000);
    act(() => { useCanvasPinsStore.getState().compose({ position: { x: 0, y: 0 } }); });
    await settle();
    expect(pins.pinTextSettled()).toBe(false);
    expect(screen.getByRole('textbox', { name: 'Note for agents' })).toBeTruthy();
    const counter = () => document.querySelector('.prompt-dialog__counter')?.textContent;
    expect(counter()).toBe('27 left');
    expect(keptNote()).toBe('葛 ❤');
    // It lands: nothing typed, nothing in the store changed.
    chunk.release();
    await act(async () => { await pins.pinTextSettling(); });
    await settle();
    expect(pins.pinTextIsLoaded()).toBe(true);
    // Both surfaces, so a fix that reaches only one of them shows which.
    expect({ counter: counter(), kept: keptNote() }).toEqual({ counter: '29 left', kept: KEPT_TEXT });
  });
});
