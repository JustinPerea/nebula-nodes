// PR #200 fix round 22: review 18 and GM r33.
// - LOW-1: the heading's name and its "…" sit in a <bdi>, the curly quotes
//   outside it: “<bdi>name…</bdi>”, so a Hebrew or Arabic name ends in its "…".
// - NIT-3: the heading fits again on resize and once fonts load; Send note's
//   reasons keep their order (node gone, then the gate, then an empty field).
// - NIT-R21-3 and GM r33's copy nits: the cut keys on a space (the last one
//   within 8 graphemes) and on a cut that already ends a word; the
//   punctuation a cut ends on goes before the "…"; never a bare "…".
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({ createPin: vi.fn(), fetchPins: vi.fn(), deletePin: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
vi.mock('../src/lib/canvasPins', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/canvasPins')>(), ...api }));

const { PIN_REFUSAL_COPY, pinTextReady } = await import('../src/lib/canvasPins');
const { fitNoteHeading, graphemesOf, noteHeading, wordCut } = await import('../src/lib/noteHeading');
const { PinComposer } = await import('../src/components/canvas/PinComposer');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');
const { useGraphStore } = await import('../src/store/graphStore');
const session = await import('../src/lib/personSession');

const TEST_SEG = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (text: string) => Array.from(TEST_SEG.segment(text), (part) => part.segment);
const WIDE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
let charPx = 8;
const textWidth = (text: string) => graphemes(text).reduce((sum, g) => sum + (EMOJI.test(g) ? 20 : WIDE.test(g) ? 16 : charPx), 0);
const fits = (title: string, available: number) => fitNoteHeading(title, available, textWidth);
const room = (title: string, start: string) => textWidth(`Note for agents on “${start}…”`);
const heading = (kept: string) => `Note for agents on “${kept}…”`;
const node = (id: string, label: string) => ({ id, type: 'text-input', position: { x: 0, y: 0 }, data: { definitionId: 'text-input', params: {}, label } });
const send = () => screen.getByRole('button', { name: 'Send note' }) as HTMLButtonElement;
const field = () => document.querySelector('.prompt-dialog textarea') as HTMLTextAreaElement;
const shown = () => document.querySelector('.prompt-dialog__heading-text');

let boxWidth = 300;
function layout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains('prompt-dialog__heading') ? boxWidth
      : this.parentElement?.classList.contains('prompt-dialog__heading-measure') ? textWidth(this.textContent ?? '') : 0;
    return { width, height: 20, top: 0, left: 0, right: width, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

beforeAll(() => pinTextReady);
beforeEach(() => {
  useCanvasPinsStore.setState({ pins: [], composer: null, composerCanvas: null, removing: {}, error: null, errorProject: null,
    errorPersonGate: false, draft: '', drafts: {}, kept: [], targetGone: false, tooLongRefusals: 0 });
  useGraphStore.setState({ nodes: [] } as never);
  boxWidth = 300; charPx = 8;
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => { cleanup(); session.resetPersonSessionForTests(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('review 18 LOW-1, GM r33: the name in a <bdi>, the curly quotes outside it', () => {
  it.each([
    ['Hebrew', 'מגדלור בשעת ערב עם אור חם על הסלעים ליד הים'],
    ['Arabic', 'منارة عند الغسق مع ضوء دافئ فوق الصخور قرب البحر'],
  ])('%s: “<bdi>name…</bdi>”, the "…" inside the isolate; the measure is the same shape', (_label, title) => {
    layout();
    useGraphStore.setState({ nodes: [node('n1', title)] } as never);
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<PinComposer />);
    const text = shown()!;
    const parts = [...text.childNodes].map((part) => [part.nodeName, part.textContent]);
    expect(parts[0]).toEqual(['#text', 'Note for agents on “']);
    expect(parts[1][0]).toBe('BDI');
    expect(parts[1][1]!.endsWith('…')).toBe(true);
    expect(title.startsWith(parts[1][1]!.slice(0, -1))).toBe(true);
    expect(parts[2]).toEqual(['#text', '”']);
    expect(parts).toHaveLength(3);
    expect(document.querySelector('.prompt-dialog__heading-measure bdi')).not.toBeNull();
    // The tooltip and the field's name keep the whole name.
    expect(text.getAttribute('title')).toBe(`Note for agents on “${title}”`);
    expect(screen.getByRole('textbox', { name: `Note for agents on “${title}”` })).toBeTruthy();
  });

  it('a name that fits is in a <bdi> too, with no "…"', () => {
    layout(); boxWidth = 2000;
    useGraphStore.setState({ nodes: [node('n1', 'מגדלור')] } as never);
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<PinComposer />);
    expect(shown()!.querySelector('bdi')?.textContent).toBe('מגדלור');
  });
});

describe('review 18 NIT-3: the heading fits again on resize and on font load', () => {
  const title = 'A lighthouse prompt with warm light on the rocks at dusk';

  it('a resize refits it, wider and narrower', () => {
    layout();
    // Only an observer watching the heading's box is told it resized.
    const observers: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; }
      observe(target: Element) { if (target.classList.contains('prompt-dialog__heading')) observers.push(this.cb); }
      disconnect() { const at = observers.indexOf(this.cb); if (at >= 0) observers.splice(at, 1); }
    });
    boxWidth = room(title, 'A lighthouse prompt') + 2;
    useGraphStore.setState({ nodes: [node('n1', title)] } as never);
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<PinComposer />);
    expect(shown()!.textContent).toBe(heading('A lighthouse prompt'));
    boxWidth = room(title, 'A lighthouse prompt with warm light') + 2;
    act(() => observers.forEach((cb) => cb()));
    expect(shown()!.textContent).toBe(heading('A lighthouse prompt with warm light'));
    boxWidth = room(title, 'A lighthouse') + 2;
    act(() => observers.forEach((cb) => cb()));
    expect(shown()!.textContent).toBe(heading('A lighthouse'));
  });

  it('the heading\'s font landing late refits it', async () => {
    layout();
    let loaded!: () => void;
    const ready = new Promise<void>((resolve) => { loaded = resolve; });
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } });
    boxWidth = room(title, 'A lighthouse prompt with warm') + 2;
    useGraphStore.setState({ nodes: [node('n1', title)] } as never);
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<PinComposer />);
    expect(shown()!.textContent).toBe(heading('A lighthouse prompt with warm'));
    // The real font is wider: once it loads, fewer words fit.
    charPx = 12;
    await act(async () => { loaded(); await ready; });
    expect(textWidth(shown()!.textContent!)).toBeLessThanOrEqual(boxWidth);
    // 12px a character: "A lighthouse prompt" no longer fits; "A lighthouse" does.
    expect(shown()!.textContent).toBe(heading('A lighthouse'));
    Reflect.deleteProperty(document, 'fonts');
  });
});

describe('review 18 NIT-3: Send note\'s reasons in order', () => {
  it('node gone beats the gate, the gate beats an empty field, and an empty field shows last', () => {
    useGraphStore.setState({ nodes: [node('n1', 'Text Input')] } as never);
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<PinComposer />);
    expect(send().title).toBe(PIN_REFUSAL_COPY.writeFirst);
    act(() => session.reportPersonRequired());
    expect(send().title).toBe(PIN_REFUSAL_COPY.sendWhenConnected);
    act(() => useGraphStore.setState({ nodes: [] } as never));
    expect(send().title).toBe(PIN_REFUSAL_COPY.nodeGone);
    act(() => useGraphStore.setState({ nodes: [node('n1', 'Text Input')] } as never));
    act(() => useCanvasPinsStore.getState().targetReturned());
    expect(send().title).toBe(PIN_REFUSAL_COPY.sendWhenConnected);
    act(() => session.notePersonPromoted());
    expect(send().title).toBe(PIN_REFUSAL_COPY.writeFirst);
    fireEvent.change(field(), { target: { value: 'warmer' } });
    expect(send().disabled).toBe(false);
  });
});

describe('review 18 NIT-2: the cut is by grapheme, literally', () => {
  it('a ZWJ family, a flag, a skin tone and a combining mark are each one grapheme, and a cut keeps them whole', () => {
    expect(graphemesOf('👨‍👩‍👧‍👦a🇯🇵👍🏽é̂')).toEqual(['👨‍👩‍👧‍👦', 'a', '🇯🇵', '👍🏽', 'é̂']);
    expect(noteHeading('👨‍👩‍👧‍👦a🇯🇵👍🏽é̂ and more', 1)).toBe('Note for agents on “👨‍👩‍👧‍👦…”');
    expect(noteHeading('👨‍👩‍👧‍👦a🇯🇵👍🏽é̂ and more', 3)).toBe('Note for agents on “👨‍👩‍👧‍👦a🇯🇵…”');
    expect(noteHeading('👨‍👩‍👧‍👦a🇯🇵👍🏽é̂ and more', 5)).toBe('Note for agents on “👨‍👩‍👧‍👦a🇯🇵👍🏽é̂…”');
  });
});

describe('the cut keys on a space; GM r33 copy nits', () => {
  it('a space before a word that starts with punctuation, or one joined by a hyphen, is where it steps back', () => {
    const paren = 'A lighthouse (warm light) at dusk';
    expect(fits(paren, room(paren, 'A lighthouse (wa'))).toBe(heading('A lighthouse'));
    const hyphen = 'A sea-glass shore at dusk';
    expect(fits(hyphen, room(hyphen, 'A sea-gla'))).toBe(heading('A'));
  });

  it('the last space within 8, not the first; a cut that already ends a word stays', () => {
    const title = 'A bb cc dddd eeee';
    expect(fits(title, room(title, 'A bb cc dd'))).toBe(heading('A bb cc'));
    const words = 'A lighthouse prompt with warm light';
    expect(fits(words, room(words, 'A lighthouse prompt'))).toBe(heading('A lighthouse prompt'));
    expect(wordCut(graphemes('A lighthouse prompt').length, graphemes(words))).toBe(graphemes('A lighthouse prompt').length);
  });

  it('a step back after a comma drops it: "Lighthouse…”"; so does a grapheme cut right after punctuation', () => {
    const comma = 'Lighthouse, warm light over the bay';
    expect(fits(comma, room(comma, 'Lighthouse, wa'))).toBe(heading('Lighthouse'));
    const glued = 'Lighthouse—warmlightoverthebayatdusk';
    expect(fits(glued, room(glued, 'Lighthouse—'))).toBe(heading('Lighthouse'));
    const colon = '灯台：夕暮れの岩に暖かい光が差し込む長い説明文です';
    expect(fits(colon, room(colon, '灯台：'))).toBe(heading('灯台'));
  });

  it('never a bare "…": a name that starts with a space, or with punctuation, keeps something visible', () => {
    expect(fits(' lighthouse prompt with warm light', room(' lighthouse prompt with warm light', ' lig'))).not.toBe('Note for agents on “…”');
    expect(fits(' lighthouse prompt with warm light', 1)).toBe(heading('l'));
    expect(fits('( lighthouse prompt with warm light', room('( lighthouse prompt with warm light', '( lig'))).toBe(heading('( lig'));
  });
});
