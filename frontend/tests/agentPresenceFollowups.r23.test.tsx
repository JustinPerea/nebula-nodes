// PR #200 fix round 14, GM r23 (answers to review 13) and review 13 NIT-3.
// Item 1 (the selectors) is the backend's and the shared corpus's
// (backend/tests/test_pin_text_r23.py; the corpus's `note` is what the
// canvas shows, registered variants kept, and agentPresenceFollowups.r12text
// checks this side gives it). Here: item 2's lines and the removed-node
// state, item 3's counter, item 4's announcements, NIT-3.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RequestFailedError, personRequiredCopy } from '../src/lib/errorCopy';
import corpus from '../../backend/tests/fixtures/pin_text_cases.json';

const api = vi.hoisted(() => ({ createPin: vi.fn(), fetchPins: vi.fn(), deletePin: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
vi.mock('../src/lib/canvasPins', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/canvasPins')>(), ...api }));

const { MAX_PIN_TEXT, PIN_REFUSAL_COPY, noteLength, pinDisplayText, pinRefusalLine, pinTextReady, HIDDEN_TEXT_CODE, TOO_LONG_CODE }
  = await import('../src/lib/canvasPins');
const { PromptDialog } = await import('../src/components/PromptDialog');
const { PinComposer } = await import('../src/components/canvas/PinComposer');
// The app draws its notices in the notice region, which stays usable beside
// an open dialog (ModalPortal isolates everything else, GM PR #203 r13).
const { NoticeRegion } = await import('../src/components/NoticeRegion');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');
const { useGraphStore } = await import('../src/store/graphStore');

const refused = (status: number, code?: string) => new RequestFailedError("Couldn't add the pin.", status, { detail: 'x', code: code ?? null });
const field = () => screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
const send = () => screen.getByRole('button', { name: 'Send note' }) as HTMLButtonElement;
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
const edit = async (value: string) => {
  await act(async () => {
    const box = field();
    setter.call(box, value);
    box.setSelectionRange(value.length, value.length);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
};
const counter = () => {
  const el = document.querySelector('.prompt-dialog__counter');
  return el?.hasAttribute('data-shown') ? el.textContent : null;
};
const announced = () => document.querySelector('.prompt-dialog__announce')?.textContent ?? '';
/** Every live region on the page whose text holds `line` (a role="status" or
 * aria-live element, nested ones counted once each). */
const liveWith = (line: string) => [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')]
  .filter((el) => el.getAttribute('aria-live') !== 'off' && (el.textContent ?? '').includes(line));

beforeAll(() => pinTextReady);
beforeEach(() => {
  useCanvasPinsStore.setState({ pins: [], composer: null, composerCanvas: null, removing: {}, error: null, errorProject: null,
    draft: '', drafts: {}, kept: [], targetGone: false, tooLongRefusals: 0 });
  useGraphStore.setState({ nodes: [] });
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(cleanup);

describe('GM r23 item 2: the lines', () => {
  it('reads GM\'s lines by code, word for word', () => {
    expect(PIN_REFUSAL_COPY.openNotesFull).toBe('This canvas has 100 open notes. Resolve or delete some, then add this one.');
    expect(PIN_REFUSAL_COPY.nodeGone).toBe('That node was removed, so the note wasn’t added.');
    expect(pinRefusalLine(refused(409, 'open_notes_full'), 'add')).toBe(PIN_REFUSAL_COPY.openNotesFull);
    expect(pinRefusalLine(refused(404, 'pin_node_gone'), 'add')).toBe(PIN_REFUSAL_COPY.nodeGone);
    // A tab not connected as the person: the banner's own line (review 13 L-1).
    expect(pinRefusalLine(refused(403, 'person_required'), 'add')).toBe(personRequiredCopy());
    expect(pinRefusalLine(refused(403, 'agent_refused'), 'add')).toBe(PIN_REFUSAL_COPY.canvasOnly);
  });
});

describe('GM r23 item 2: a removed node holds Send note', () => {
  it('Nebula says the node went: Send note disabled with the line as its reason; Cancel live, the text kept', async () => {
    api.createPin.mockRejectedValue(refused(404, 'pin_node_gone'));
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<><NoticeRegion /><PinComposer /></>);
    await edit('make it warmer');
    await act(async () => { fireEvent.click(send()); });
    expect(send().disabled).toBe(true);
    expect(send().title).toBe(PIN_REFUSAL_COPY.nodeGone);
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled();
    expect(field().value).toBe('make it warmer');
    expect(liveWith(PIN_REFUSAL_COPY.nodeGone)).toHaveLength(1);
    // Enter does nothing more: no second send.
    await act(async () => { fireEvent.submit(field().form!); });
    expect(api.createPin).toHaveBeenCalledTimes(1);
  });

  it('the canvas loses the node while the dialog is open: the same, with nothing sent', async () => {
    useGraphStore.setState({ nodes: [{ id: 'n1', position: { x: 0, y: 0 }, data: {} } as never] });
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<><NoticeRegion /><PinComposer /></>);
    await edit('make it warmer');
    expect(send().disabled).toBe(false);
    await act(async () => { useGraphStore.setState({ nodes: [] }); });
    expect(send().disabled).toBe(true);
    expect(send().title).toBe(PIN_REFUSAL_COPY.nodeGone);
    expect(field().value).toBe('make it warmer');
    expect(liveWith(PIN_REFUSAL_COPY.nodeGone)).toHaveLength(1);
    expect(api.createPin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useCanvasPinsStore.getState().composer).toBeNull();
    expect(useCanvasPinsStore.getState().drafts['']).toBe('make it warmer');
  });

  it('a node the canvas hasn\'t loaded is not "removed"', () => {
    // A note in the field (GM r30 item 3: an empty one can't be sent anyway).
    useCanvasPinsStore.setState({ drafts: { '': 'warmer' } });
    useCanvasPinsStore.getState().compose({ nodeId: 'n7' });
    render(<><NoticeRegion /><PinComposer /></>);
    expect(send().disabled).toBe(false);
  });

  it('the 100-notes refusal keeps Send note live (resolving one makes room)', async () => {
    api.createPin.mockRejectedValue(refused(409, 'open_notes_full'));
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<><NoticeRegion /><PinComposer /></>);
    await edit('one more');
    await act(async () => { fireEvent.click(send()); });
    expect(screen.getByRole('status').textContent).toBe(`${PIN_REFUSAL_COPY.openNotesFull}×`);
    expect(send().disabled).toBe(false);
  });
});

describe('GM r23 item 3 and review 13 NIT-3: the counter', () => {
  const CAP = { max: MAX_PIN_TEXT, count: noteLength, showAt: 30 };
  it('a note_too_long refusal turns "N left" on; the next edit leaving more than 30 hides it, with a fade', async () => {
    api.createPin.mockRejectedValue(refused(422, TOO_LONG_CODE));
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<><NoticeRegion /><PinComposer /></>);
    await edit('b'.repeat(100));
    expect(counter()).toBeNull();
    await act(async () => { fireEvent.click(send()); });
    expect(counter()).toBe('180 left');
    await edit('b'.repeat(90));
    expect(counter()).toBeNull();
    // Still laid out with its last words while it fades (nothing moves).
    const el = document.querySelector('.prompt-dialog__counter')!;
    expect(el.textContent).toBe('180 left');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('a refused edit shows it until an edit leaves more than 30; within 30 it stays', async () => {
    render(<PromptDialog request={{ label: 'Note for agents', initial: 'a'.repeat(260), resolve: () => {} }} onDone={() => {}} cap={CAP} multiline confirmLabel="Send note" />);
    await edit('a'.repeat(400));
    expect(counter()).toBe('20 left');
    await edit('a'.repeat(255));
    expect(counter()).toBe('25 left');
    await edit('a'.repeat(240));
    expect(counter()).toBeNull();
  });

  it('the fade is in the sheet, on the notice region\'s curves, and off for reduced motion', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sheet = readFileSync(join(__dirname, '../src/styles/prompt-dialog.css'), 'utf8');
    expect(sheet).toMatch(/\.prompt-dialog__counter \{[^}]*opacity: 0;[^}]*visibility: hidden;[^}]*transition: opacity 294ms linear\(/s);
    expect(sheet).toMatch(/\.prompt-dialog__counter\[data-shown\] \{[^}]*opacity: 1;/s);
    expect(sheet).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.prompt-dialog__counter,/);
  });
});

describe('GM r23 item 4: screen readers', () => {
  const CAP = { max: MAX_PIN_TEXT, count: noteLength, showAt: 30 };
  it('the visible counter is not live; one polite region speaks at 30, 10 and 0 left only', async () => {
    render(<PromptDialog request={{ label: 'Note for agents', initial: '', resolve: () => {} }} onDone={() => {}} cap={CAP} multiline confirmLabel="Send note" />);
    expect(document.querySelector('.prompt-dialog__counter')?.hasAttribute('aria-live')).toBe(false);
    const region = document.querySelector('.prompt-dialog__announce')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
    const heard: string[] = [];
    for (const length of [100, 249, 250, 251, 255, 269, 270, 275, 279, 280]) {
      await edit('a'.repeat(length));
      if (announced() && announced() !== heard[heard.length - 1]) heard.push(announced());
    }
    expect(heard).toEqual(['30 characters left', '10 characters left', '0 characters left']);
  });

  it('a paste that jumps past a mark says the count it lands on, once', async () => {
    render(<PromptDialog request={{ label: 'Note for agents', initial: '', resolve: () => {} }} onDone={() => {}} cap={CAP} multiline confirmLabel="Send note" />);
    await edit('a'.repeat(275));
    expect(announced()).toBe('5 characters left');
  });

  it.each([
    ['too long', refused(422, TOO_LONG_CODE)],
    ['hidden text', refused(422, HIDDEN_TEXT_CODE)],
    ['100 open notes', refused(409, 'open_notes_full')],
    ['node removed', refused(404, 'pin_node_gone')],
    ['not connected as the person', refused(403, 'person_required')],
    ['not the canvas', refused(403, 'agent_refused')],
    ['another 4xx', refused(422)],
    ['no answer', new Error('network')],
  ])('%s: its line is spoken once, through the toast\'s own live region', async (_name, error) => {
    api.createPin.mockRejectedValue(error);
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<><NoticeRegion /><PinComposer /></>);
    await edit('b'.repeat(100));
    await act(async () => { fireEvent.click(send()); });
    const line = useCanvasPinsStore.getState().error!;
    expect(line).toBeTruthy();
    const regions = liveWith(line);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveClass('canvas-pin-toast--notice');
    // The counter (turned on by too long) never repeats it.
    expect(announced()).not.toContain(line);
  });
});

describe('GM r23 item 1 on the canvas: a registered variant is kept, an unregistered one dropped', () => {
  it('matches the corpus the backend wrote', () => {
    const cases = (corpus as { cases: Array<{ name: string; typed: string; note: string; agent: string }> }).cases;
    for (const c of cases.filter((x) => x.name.startsWith('GM r23') || x.name.startsWith('fuzz r23'))) {
      expect(pinDisplayText(c.typed, { fold: false }), c.name).toBe(c.note);
    }
    expect(pinDisplayText('葛\u{E0100}')).toBe('葛\u{E0100}');
    expect(pinDisplayText('葛\u{E010A}')).toBe('葛');
    expect(pinDisplayText('一\u{E0101}')).toBe('一');
  });
});
