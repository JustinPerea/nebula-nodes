// PR #218 review 1 LOW-1: the Unicode chunk failed at startup, so PinComposer
// was already counting with the strict fallbacks. The dialog opening loads it
// again; when it lands, the open dialog's "N left" and the kept-note notices
// redraw in the full form at once, with no keystroke and no store change.
//
// GM's sign-off on #220 rests on three conditions, pinned here:
// 1. The refit leaves the person where they were: same field focused, same
//    selection, same text.
// 2. It is silent: the polite region says nothing. PromptDialog speaks only
//    when "N left" goes DOWN past 30, 10 or 0 (`left < leftBefore` and a mark
//    crossed). The fallbacks always count at least as many characters as the
//    real data (they hide every selector and split every ZWJ chain, never
//    the reverse), so a refit can only raise "N left": nothing to say. That
//    holds whether the counter shows because the note is at 30 or fewer, or
//    because a note_too_long refusal revealed it.
// 3. The flow itself: the chunk fails at startup, the dialog's opening
//    retries it, the retry lands, and the count goes 27 -> 29 (or 77 -> 79
//    when revealed). The order of listings around that load is pinned in
//    canvasPinsStore.hydrateOrder.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));

const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((done) => setTimeout(done, 0)); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetModules(); });

// A family (one character with the data, its three people without it).
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
// A registered ideographic variant and an emoji heart: the fallback hides both selectors.
const KEPT_TEXT = '葛\u{E0100} ❤️';

/** A fresh canvasPins, store and PinComposer whose chunk fails until `chunk.fail` turns false, then waits for `chunk.release()`. */
async function freshModules() {
  vi.resetModules();
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const chunk = { fail: true, release: () => release() };
  // Again for each case: a module from a vi.mock factory outlives resetModules,
  // so the first case's loaded chunk would carry over.
  vi.doMock('../src/lib/pinTextUnicode.json', async (importOriginal) => {
    if (chunk.fail) throw new Error('the chunk failed to load');
    await gate;
    return importOriginal();
  });
  const pins = await import('../src/lib/canvasPins');
  const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');
  const { PinComposer } = await import('../src/components/canvas/PinComposer');
  return { chunk, pins, useCanvasPinsStore, PinComposer };
}

type Case = { name: string; draft: string; reveal: boolean; before: string; after: string };
const CASES: Case[] = [
  // 250 letters and a family: 29 left in the full form, 27 in the fallback's; shown (30 or fewer).
  { name: 'at 30 or fewer left', draft: 'a'.repeat(250) + FAMILY, reveal: false, before: '27 left', after: '29 left' },
  // 200 letters and a family: 79 left in the full form, 77 in the fallback's; shown only because a note_too_long refusal revealed it.
  { name: 'revealed by a note_too_long refusal', draft: 'a'.repeat(200) + FAMILY, reveal: true, before: '77 left', after: '79 left' },
];

describe('PR #218 review 1 LOW-1: the chunk loaded again refits what PinComposer shows', () => {
  it.each(CASES)('$name: the count and the kept note refit; focus, selection and text stay; nothing is spoken', async ({ draft, reveal, before, after }) => {
    const { chunk, pins, useCanvasPinsStore, PinComposer } = await freshModules();
    await pins.pinTextReady;
    expect(pins.pinTextSettled()).toBe(true);
    expect(pins.pinTextIsLoaded()).toBe(false);
    useCanvasPinsStore.setState({
      drafts: { '': draft },
      kept: [{ text: KEPT_TEXT, project: 'p-other', projectName: 'Other', following: null, line: pins.noteKeptLine(null) }],
    });
    // Mounted after the failure: it counts at once, in the fallback form.
    render(<PinComposer />);
    await settle();
    const keptNote = () => document.querySelector('.canvas-pin-toast__note')?.textContent;
    expect(keptNote()).toBe('葛 ❤');
    // The chunk is reachable again but slow; the retry gap has passed; the dialog opens (a need), which retries it.
    chunk.fail = false;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + pins.PIN_TEXT_RETRY_GAP_MS + 1000);
    act(() => { useCanvasPinsStore.getState().compose({ position: { x: 0, y: 0 } }); });
    if (reveal) act(() => { useCanvasPinsStore.setState({ tooLongRefusals: 1 }); });
    await settle();
    expect(pins.pinTextSettled()).toBe(false);
    const field = screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
    const counter = () => document.querySelector('.prompt-dialog__counter')?.textContent;
    const spoken = () => document.querySelector('.prompt-dialog__announce')?.textContent;
    expect(counter()).toBe(before);
    expect(spoken()).toBe('');
    // The person is mid-edit: the field focused, a selection in the middle of the text.
    act(() => { field.focus(); field.setSelectionRange(3, 7); });
    expect(document.activeElement).toBe(field);
    // It lands: nothing typed, nothing in the store changed.
    chunk.release();
    await act(async () => { await pins.pinTextSettling(); });
    await settle();
    expect(pins.pinTextIsLoaded()).toBe(true);
    // Both surfaces, so a fix that reaches only one of them shows which.
    expect({ counter: counter(), kept: keptNote() }).toEqual({ counter: after, kept: KEPT_TEXT });
    // GM condition 1: where the person was.
    const now = screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
    expect(now).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe(draft);
    expect([field.selectionStart, field.selectionEnd]).toEqual([3, 7]);
    // GM condition 2: silent (the count only went up; see the header).
    expect(spoken()).toBe('');
  });
});
