// PR #200 fix round 11 (review 10, GM r12 answer 3): only what shows counts
// against a note's 280, in characters as a person sees them, the same rule as
// the backend's services/canvas_pins.text_length (its test,
// backend/tests/test_pin_text_as_typed.py, has the same cases), so the dialog's
// limit and the backend's refusal never disagree.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pin } from '../src/lib/wsClient';

const api = vi.hoisted(() => ({ fetchPins: vi.fn(), createPin: vi.fn(), deletePin: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../src/lib/canvasPins', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/canvasPins')>(), ...api }));

const { fitNote, noteLength, textLength, MAX_PIN_TEXT } = await import('../src/lib/canvasPins');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');

const FLAG = '\u{1F1EB}\u{1F1F7}';

describe('GM r12 answer 3: the note counts what shows', () => {
  // The backend's LENGTH_CASES, case for case.
  const CASES: Array<[string, number]> = [
    ['abc', 3],
    ['é', 1],
    [FLAG, 1],
    [`${FLAG}\u{1F1E9}`, 2],
    ['\u{1F44D}\u{1F3FD}', 1],
    ['❤️', 1],
    ['́abc', 4],
    [`a${'́'.repeat(32)}`, 1],
    [`a${'́'.repeat(33)}`, 2],
    ['한글', 2],
    ['line one\nline two', 17],
  ];
  it.each(CASES)('textLength(%j) is %i, as the backend counts it', (text, expected) => {
    expect(textLength(text)).toBe(expected);
  });

  it('noteLength counts the shown text: escape codes and control bytes are not characters', () => {
    expect(noteLength('\x1b[31mred\x1b[0m')).toBe(3);
    expect(noteLength(`${'\x1b]0;hidden\x07'.repeat(50)}ok`)).toBe(2);
    expect(noteLength('a‮b')).toBe(2);
  });

  it('fitNote keeps 280 shown characters, whatever their code points, and trims past it', () => {
    expect(fitNote(FLAG.repeat(MAX_PIN_TEXT))).toBe(FLAG.repeat(MAX_PIN_TEXT));
    expect(fitNote(FLAG.repeat(MAX_PIN_TEXT + 1))).toBe(FLAG.repeat(MAX_PIN_TEXT));
    const coded = `${'\x1b[1m'.repeat(100)}${'y'.repeat(MAX_PIN_TEXT)}`;
    expect(fitNote(coded)).toBe(coded);
    expect(fitNote('x'.repeat(MAX_PIN_TEXT + 20))).toBe('x'.repeat(MAX_PIN_TEXT));
  });
});

describe('the store sends and keeps a note by what shows, never cut by code units', () => {
  beforeEach(() => {
    api.createPin.mockReset();
    useCanvasPinsStore.setState({ pins: [], composer: null, composerCanvas: null, error: null, draft: '', drafts: {}, kept: [] });
  });

  it('a note of 280 flags (560 code units) is sent whole; round 10 sent 140 of them', async () => {
    const text = FLAG.repeat(MAX_PIN_TEXT);
    api.createPin.mockImplementation(async (sent: string) => ({ id: 'pin_f', text: sent, anchor: { nodeId: 'n1' }, position: null,
      status: 'open', createdAt: '2026-10-28T00:00:00+00:00', detached: false, reply: null } satisfies Pin));
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    expect(await useCanvasPinsStore.getState().submit(text)).toBe(true);
    expect(api.createPin.mock.calls[0][0]).toBe(text);
    expect(useCanvasPinsStore.getState().pins[0].text).toBe(text);
  });

  it('a note with too much hidden text reaches the backend whole, so its refusal is the one the person reads', async () => {
    const text = `ok\x1b]0;${'h'.repeat(1200)}\x07`;
    api.createPin.mockRejectedValue(new Error('refused'));
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    await useCanvasPinsStore.getState().submit(text);
    expect(api.createPin.mock.calls[0][0]).toBe(text);
  });
});
