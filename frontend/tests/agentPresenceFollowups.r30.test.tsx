// PR #200 fix round 20.
// - GM r30 item 1: a heading too long for its line is cut inside the quotes,
//   by grapheme in JS (never CSS text-overflow), no space before "…", the
//   closing ” kept: "Note for agents on “A lighthouse prompt with…”"; the full
//   name in the tooltip; fitted to the width there is.
// - GM r30 item 2: a delete refused by the person gate while the banner shows
//   says only "Your note wasn’t deleted."; the full Q116a line once the banner
//   is gone; short again when it comes back (Send's rule).
// - GM r30 item 3: Send note is disabled while the field holds no note (empty,
//   or only what the counter doesn't count), "You can send this once you
//   write a note."
// - Review 17 LOW-1: the server promoting the tab clears a person-gate
//   refusal's toast (add and delete); it never turns into the full line.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RequestFailedError, personRequiredCopy } from '../src/lib/errorCopy';

const api = vi.hoisted(() => ({ createPin: vi.fn(), fetchPins: vi.fn(), deletePin: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
vi.mock('../src/lib/canvasPins', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/canvasPins')>(), ...api }));

const { PIN_REFUSAL_COPY, pinTextReady } = await import('../src/lib/canvasPins');
const { fitNoteHeading } = await import('../src/lib/noteHeading');
const { PinComposer } = await import('../src/components/canvas/PinComposer');
const { PersonRequiredBanner } = await import('../src/components/PersonRequiredBanner');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');
const { useGraphStore } = await import('../src/store/graphStore');
const session = await import('../src/lib/personSession');

const node = (id: string, label?: string) => ({ id, type: 'text-input', position: { x: 0, y: 0 },
  data: { definitionId: 'text-input', params: {}, ...(label === undefined ? {} : { label }) } });
const gate = () => new RequestFailedError("Couldn't save the note.", 403, { detail: 'x', code: 'person_required' });
const toast = () => document.querySelector('.canvas-pin-toast--notice')?.firstElementChild?.textContent ?? null;
const send = () => screen.getByRole('button', { name: 'Send note' }) as HTMLButtonElement;
const field = () => document.querySelector('.prompt-dialog textarea') as HTMLTextAreaElement;
const shownHeading = () => document.querySelector('.prompt-dialog__heading-text')?.textContent ?? null;
const dismissBanner = () => fireEvent.click(document.querySelector('.person-required button[aria-label="Dismiss"]')!);

// A width per grapheme as a browser draws them: CJK and emoji wider.
const WIDE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const graphemeWidth = (g: string) => (EMOJI.test(g) ? 20 : WIDE.test(g) ? 16 : 8);
// The test's own segmenter: widths never depend on the module's graphemesOf.
const TEST_SEG = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const testGraphemes = (text: string) => Array.from(TEST_SEG.segment(text), (part) => part.segment);
const textWidth = (text: string) => testGraphemes(text).reduce((sum, g) => sum + graphemeWidth(g), 0);

beforeAll(() => pinTextReady);
beforeEach(() => {
  useCanvasPinsStore.setState({ pins: [], composer: null, composerCanvas: null, removing: {}, error: null, errorProject: null,
    errorPersonGate: false, draft: '', drafts: {}, kept: [], targetGone: false, tooLongRefusals: 0 });
  useGraphStore.setState({ nodes: [] } as never);
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => { cleanup(); session.resetPersonSessionForTests(); vi.restoreAllMocks(); });

describe('GM r30 item 1: the heading is cut by grapheme, its closing quote kept', () => {
  const fits = (title: string, available: number) => fitNoteHeading(title, available, textWidth);

  it('GM\'s example: "Note for agents on “A lighthouse prompt with…”", no space before "…"', () => {
    const title = 'A lighthouse prompt with warm light on the rocks at dusk';
    const available = textWidth('Note for agents on “A lighthouse prompt with…”') + 4;
    expect(fits(title, available)).toBe('Note for agents on “A lighthouse prompt with…”');
    // One grapheme wider would end on the space: still no space before "…".
    expect(fits(title, available + 8)).toBe('Note for agents on “A lighthouse prompt with…”');
    expect(fits(title, 10_000)).toBe(`Note for agents on “${title}”`);
  });

  // Review 18 NIT-2 (fix round 22): literal expectations, measured with the
  // test's own segmenter (TEST_SEG), never the module's graphemesOf, so a cut
  // that split a ZWJ family, a flag, a skin tone or a mark would fail.
  it.each([
    ['emoji with ZWJ, skin tones and flags', "👨‍👩‍👧‍👦 family trip 👍🏽 to 🇯🇵 and 🏴󠁧󠁢󠁳󠁣󠁴󠁿 with 🧑🏾‍🚀 friends and more", { 200: 'Note for agents on “👨‍👩‍👧‍👦…”', 260: 'Note for agents on “👨‍👩‍👧‍👦 family…”', 330: 'Note for agents on “👨‍👩‍👧‍👦 family trip 👍🏽…”', 420: 'Note for agents on “👨‍👩‍👧‍👦 family trip 👍🏽 to 🇯🇵 and…”' }],
    ['CJK', "灯台のプロンプト、夕暮れの岩に暖かい光が差し込む長い説明文です", { 200: 'Note for agents on “灯…”', 260: 'Note for agents on “灯台のプロ…”', 330: 'Note for agents on “灯台のプロンプト、夕…”', 420: 'Note for agents on “灯台のプロンプト、夕暮れの岩に…”' }],
    ['Hangul and a combining mark (Korean steps back to a space, GM r32)', "등대 프롬프트 저녁 바위 위의 따뜻한 빛 é̂ 그리고 더 긴 설명", { 200: 'Note for agents on “등…”', 260: 'Note for agents on “등대…”', 330: 'Note for agents on “등대 프롬프트 저녁…”', 420: 'Note for agents on “등대 프롬프트 저녁 바위 위의…”' }],
  ] as Array<[string, string, Record<number, string>]>)('%s: whole graphemes only, the longest that fits, the quote outside the cut', (_label, title, expected) => {
    for (const [available, heading] of Object.entries(expected)) {
      expect(fits(title, Number(available)), `${available}px`).toBe(heading);
      expect(textWidth(heading)).toBeLessThanOrEqual(Number(available));
    }
  });

  it('the dialog shows the cut, fitted to its width; the tooltip and the field\'s name keep the full name', () => {
    const title = 'A lighthouse prompt with warm light on the rocks at dusk';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const width = this.classList.contains('prompt-dialog__heading') ? textWidth('Note for agents on “A lighthouse prompt with…”') + 4
        : this.parentElement?.classList.contains('prompt-dialog__heading-measure') ? textWidth(this.textContent ?? '')
        : this.classList.contains('prompt-dialog__node-id') ? 20 : 0;
      return { width, height: 20, top: 0, left: 0, right: width, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    useGraphStore.setState({ nodes: [node('n1', title)] } as never);
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<PinComposer />);
    expect(shownHeading()).toBe('Note for agents on “A lighthouse prompt with…”');
    const whole = `Note for agents on “${title}”`;
    expect(document.querySelector('.prompt-dialog__heading-text')?.getAttribute('title')).toBe(whole);
    expect(screen.getByRole('dialog', { name: whole })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: whole })).toBeTruthy();
  });

  it('with the id chip beside it, the cut leaves the chip its room', () => {
    const title = 'A lighthouse prompt with warm light on the rocks at dusk';
    const box = textWidth('Note for agents on “A lighthouse prompt with…”') + 4;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const width = this.classList.contains('prompt-dialog__heading') ? box
        : this.parentElement?.classList.contains('prompt-dialog__heading-measure') ? textWidth(this.textContent ?? '')
        : this.classList.contains('prompt-dialog__node-id') ? 20 : 0;
      return { width, height: 20, top: 0, left: 0, right: width, bottom: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    useGraphStore.setState({ nodes: [node('n1', title), node('n2', title)] } as never);
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n2' }));
    render(<PinComposer />);
    const shown = shownHeading()!;
    expect(shown.endsWith('…”')).toBe(true);
    // The chip's 20px (and the flex gap, which jsdom's unloaded CSS reads as 0) come off the line.
    expect(textWidth(shown)).toBeLessThanOrEqual(box - 20);
    expect(shown).not.toBe('Note for agents on “A lighthouse prompt with…”');
    expect(document.querySelector('.prompt-dialog__node-id')?.textContent).toBe('n2');
  });
});

describe('GM r30 item 2: a refused delete defers to the banner, as Send does', () => {
  const seed = () => useCanvasPinsStore.setState({ pins: [{ id: 'pin_a', text: 'a note', anchor: { nodeId: 'n1' }, position: null,
    status: 'open', createdAt: '', detached: false, reply: null }] } as never);

  it('banner up: "Your note wasn’t deleted."; banner gone: the full line; banner back: short again', async () => {
    seed();
    api.deletePin.mockImplementation(async () => { session.reportPersonRequired(); throw gate(); });
    render(<><PersonRequiredBanner /><PinComposer /></>);
    await act(async () => { await useCanvasPinsStore.getState().remove('pin_a'); });
    expect(PIN_REFUSAL_COPY.notDeleted).toBe('Your note wasn’t deleted.');
    expect(toast()).toBe('Your note wasn’t deleted.');
    await act(async () => { dismissBanner(); });
    expect(toast()).toBe(personRequiredCopy());
    act(() => session.reportPersonRequired());
    expect(toast()).toBe('Your note wasn’t deleted.');
    expect(useCanvasPinsStore.getState().pins.map((p) => p.id)).toEqual(['pin_a']);
    // A delete failing for any other reason keeps its own line, banner or not.
    api.deletePin.mockRejectedValue(new RequestFailedError("Couldn't delete the pin.", 500, { detail: 'x', code: null }));
    await act(async () => { await useCanvasPinsStore.getState().remove('pin_a'); });
    expect(toast()).toBe(PIN_REFUSAL_COPY.deleteFailed);
  });
});

describe('GM r30 item 3: Send note waits for a note', () => {
  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['line breaks and a tab', '\n\n\t \n'],
    ['an ideographic space and a no-break space', '\u3000\u00a0'],
    ['characters that draw nothing', '\u200b\u2060\u200b'],
    ['an escape code', '\u001b[31m'],
  ])('%s: disabled, "You can send this once you write a note.", Enter sends nothing and keeps the dialog', async (_label, text) => {
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<PinComposer />);
    fireEvent.change(field(), { target: { value: text } });
    expect(send().disabled).toBe(true);
    expect(send().title).toBe('You can send this once you write a note.');
    await act(async () => { fireEvent.submit(field().form!); });
    expect(api.createPin).not.toHaveBeenCalled();
    expect(useCanvasPinsStore.getState().composer).not.toBeNull();
  });

  it('one shown character makes it live; clearing it holds it again', () => {
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<PinComposer />);
    expect(send().disabled).toBe(true);
    fireEvent.change(field(), { target: { value: '  a ' } });
    expect(send().disabled).toBe(false);
    expect(send().title).toBeFalsy();
    fireEvent.change(field(), { target: { value: ' ' } });
    expect(send().disabled).toBe(true);
    // The gate's reason comes first while the banner shows.
    act(() => session.reportPersonRequired());
    expect(send().title).toBe(PIN_REFUSAL_COPY.sendWhenConnected);
  });
});

describe('review 17 LOW-1: the server promoting the tab clears a person-gate refusal', () => {
  it('a refused add: its short toast goes as the banner does, never the full line', async () => {
    api.createPin.mockImplementation(async () => { session.reportPersonRequired(); throw gate(); });
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    render(<><PersonRequiredBanner /><PinComposer /></>);
    fireEvent.change(field(), { target: { value: 'warmer please' } });
    await act(async () => { fireEvent.click(send()); });
    expect(toast()).toBe(PIN_REFUSAL_COPY.notAdded);
    const seen: Array<string | null> = [];
    const watch = new MutationObserver(() => seen.push(toast()));
    watch.observe(document.body, { subtree: true, childList: true, characterData: true });
    act(() => session.notePersonPromoted());
    watch.disconnect();
    expect(document.querySelector('.person-required')).toBeNull();
    expect(toast()).toBeNull();
    expect(seen).not.toContain(personRequiredCopy());
    expect(useCanvasPinsStore.getState().error).toBeNull();
    // The note is still in the dialog, and Send note is live.
    expect(field().value).toBe('warmer please');
    expect(send().disabled).toBe(false);
    // Another refusal stays through a promote: only the gate's is no longer true.
    act(() => useCanvasPinsStore.setState({ error: PIN_REFUSAL_COPY.openNotesFull, errorProject: null, errorPersonGate: false }));
    act(() => session.notePersonPromoted());
    expect(toast()).toBe(PIN_REFUSAL_COPY.openNotesFull);
  });

  it('a refused delete: its toast goes, after the banner\'s × too', async () => {
    useCanvasPinsStore.setState({ pins: [{ id: 'pin_a', text: 'a note', anchor: { nodeId: 'n1' }, position: null,
      status: 'open', createdAt: '', detached: false, reply: null }] } as never);
    api.deletePin.mockImplementation(async () => { session.reportPersonRequired(); throw gate(); });
    render(<><PersonRequiredBanner /><PinComposer /></>);
    await act(async () => { await useCanvasPinsStore.getState().remove('pin_a'); });
    await act(async () => { dismissBanner(); });
    expect(toast()).toBe(personRequiredCopy());
    act(() => session.notePersonPromoted());
    expect(toast()).toBeNull();
    expect(useCanvasPinsStore.getState().error).toBeNull();
  });

});
