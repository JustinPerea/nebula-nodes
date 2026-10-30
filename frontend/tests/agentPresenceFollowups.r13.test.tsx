// PR #200 fix round 13 (GM r20).
// Q1: every pin refusal is one neutral line with no "Couldn't …" heading,
// read by the answer's code and status; the typed note stays in the field on
// any failure; a failed delete keeps the pin. Note 1 and its addendum: a
// neutral "N left" under the note field from 30 left, and at once, whatever
// is left, once an edit has been refused; a paste that won't fit is refused
// whole. (Q3, the presence-colour author edge, is in the ratchet.)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RequestFailedError } from '../src/lib/errorCopy';

const api = vi.hoisted(() => ({ createPin: vi.fn(), fetchPins: vi.fn(), deletePin: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
vi.mock('../src/lib/canvasPins', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/canvasPins')>(), ...api }));

const { HIDDEN_TEXT_COPY, MAX_PIN_TEXT, PIN_REFUSAL_COPY, noteLength, pinRefusalLine } = await import('../src/lib/canvasPins');
const { PromptDialog } = await import('../src/components/PromptDialog');
const { PinComposer } = await import('../src/components/canvas/PinComposer');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');

const pin = (id: string) => ({ id, text: 'note', anchor: { nodeId: 'n1' }, position: null, status: 'open' as const,
  createdAt: '2026-10-29T00:00:00+00:00', detached: false, reply: null });
const refused = (status: number, code?: string) => new RequestFailedError("Couldn't save the note.", status, { detail: 'x', code: code ?? null });

beforeEach(() => {
  useCanvasPinsStore.setState({ pins: [], composer: null, composerCanvas: null, removing: {}, error: null, errorProject: null,
    draft: '', drafts: {}, kept: [] });
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(cleanup);

describe('GM r20 Q1: every pin refusal is one neutral line', () => {
  it('the lines are GM\'s, word for word, with ’ and no "Couldn\'t" heading', () => {
    expect(PIN_REFUSAL_COPY).toEqual({
      tooLong: 'Notes can be up to 280 characters. Shorten this one, then try again.',
      hidden: 'This note has too much hidden text to save. Paste it as plain text, then try again.',
      addRefused: 'Nebula can’t add this pin. Try again in a moment.',
      saveRefused: 'Nebula can’t save this note. Try again in a moment.',
      addNoAnswer: 'Nebula didn’t answer, so the pin wasn’t added. Try again in a moment.',
      saveNoAnswer: 'Nebula didn’t answer, so the note wasn’t saved. Try again in a moment.',
      deleteFailed: 'Nebula couldn’t delete this note. Try again in a moment.',
      canvasOnly: 'Notes can only be added from the Nebula canvas.',
      openNotesFull: 'This canvas has 100 open notes. Resolve or delete some, then add this one.',
      nodeGone: 'That node was removed, so the note wasn’t added.',
      notAdded: 'Your note wasn’t added.',
      notDeleted: 'Your note wasn’t deleted.',
      sendWhenConnected: 'You can send notes when this tab is connected as you.',
      writeFirst: 'You can send this once you write a note.',
    });
    for (const line of Object.values(PIN_REFUSAL_COPY)) {
      expect(line).not.toMatch(/'/);
      expect(line).not.toMatch(/^Couldn/);
    }
  });

  it.each([
    ['over 280 (its code)', refused(422, 'note_too_long'), PIN_REFUSAL_COPY.tooLong],
    ['too much hidden text (its code)', refused(422, 'note_hidden_too_long'), HIDDEN_TEXT_COPY],
    ['another 4xx', refused(422), PIN_REFUSAL_COPY.addRefused],
    ['a 409 that isn\'t the canvas going', refused(409), PIN_REFUSAL_COPY.addRefused],
    ['a 5xx', refused(503), PIN_REFUSAL_COPY.addNoAnswer],
    ['no answer at all', new TypeError('Failed to fetch'), PIN_REFUSAL_COPY.addNoAnswer],
  ])('an add refused for %s: the dialog stays open with the note, one neutral line', async (_name, error, line) => {
    api.createPin.mockRejectedValue(error);
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    expect(await useCanvasPinsStore.getState().submit('  keep me  ')).toBe(false);
    const state = useCanvasPinsStore.getState();
    expect(state.error).toBe(line);
    expect(state.composer).toEqual({ nodeId: 'n1' });
    expect(state.draft).toBe('  keep me  ');
  });

  it('a save reads its own lines (no person path saves a note today; the copy is ready for one)', () => {
    expect(pinRefusalLine(refused(400), 'save')).toBe(PIN_REFUSAL_COPY.saveRefused);
    expect(pinRefusalLine(refused(500), 'save')).toBe(PIN_REFUSAL_COPY.saveNoAnswer);
    expect(pinRefusalLine(refused(422, 'note_too_long'), 'save')).toBe(PIN_REFUSAL_COPY.tooLong);
  });

  it('a failed delete keeps the pin and says so in one neutral line', async () => {
    api.deletePin.mockRejectedValue(refused(500));
    useCanvasPinsStore.setState({ pins: [pin('pin_a')] });
    await useCanvasPinsStore.getState().remove('pin_a');
    expect(useCanvasPinsStore.getState().pins.map((p) => p.id)).toEqual(['pin_a']);
    expect(useCanvasPinsStore.getState().error).toBe(PIN_REFUSAL_COPY.deleteFailed);
    render(<PinComposer />);
    const toast = screen.getByRole('status');
    expect(toast).toHaveClass('canvas-pin-toast', 'canvas-pin-toast--notice');
    expect(toast.textContent).toBe(`${PIN_REFUSAL_COPY.deleteFailed}×`);
  });

  it('the composer: a refused add shows the neutral status over the open dialog, the note still in the field', async () => {
    api.createPin.mockRejectedValue(refused(503));
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<PinComposer />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for agents' }), { target: { value: 'warmer please' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send note' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(`${PIN_REFUSAL_COPY.addNoAnswer}×`);
    expect((screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement).value).toBe('warmer please');
  });

  it('no pin toast is red any more: the error class and its rules are gone', () => {
    const sheet = readFileSync(join(__dirname, '../src/styles/canvasPins.css'), 'utf8');
    expect(sheet).not.toMatch(/canvas-pin-toast--error/);
    const composer = readFileSync(join(__dirname, '../src/components/canvas/PinComposer.tsx'), 'utf8');
    expect(composer).not.toMatch(/role="alert"|toast--error/);
  });
});

describe('GM r20 note 1 and addendum: the "N left" counter', () => {
  const CAP = { max: MAX_PIN_TEXT, count: noteLength, showAt: 30 };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  const open = (initial = '') => {
    render(<PromptDialog request={{ label: 'Note for agents', initial, resolve: () => {} }} onDone={() => {}} cap={CAP} multiline confirmLabel="Send note" />);
    return screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
  };
  const edit = async (field: HTMLTextAreaElement, value: string, caret: number) => {
    await act(async () => {
      setter.call(field, value);
      field.setSelectionRange(caret, caret);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
  };
  // Always laid out (it fades, GM r23 item 3): shown is data-shown.
  const counter = () => {
    const el = document.querySelector('.prompt-dialog__counter');
    return el?.hasAttribute('data-shown') ? el.textContent : null;
  };

  it('hidden with more than 30 left; "30 left" at 30, counting down to "0 left"; a label, no period', async () => {
    const field = open('a'.repeat(249));
    expect(counter()).toBeNull();
    await edit(field, 'a'.repeat(250), 250);
    expect(counter()).toBe('30 left');
    await edit(field, 'a'.repeat(280), 280);
    expect(counter()).toBe('0 left');
    await edit(field, 'a'.repeat(200), 200);
    expect(counter()).toBeNull();
  });

  it('counts what shows, by the cap\'s rule: escape codes don\'t count, a flag is one', async () => {
    const field = open();
    await edit(field, `${'\x1b[31m'.repeat(50)}${'y'.repeat(260)}`, 410);
    expect(counter()).toBe('20 left');
    await edit(field, '\u{1F1EB}\u{1F1F7}'.repeat(255), 1020);
    expect(counter()).toBe('25 left');
  });

  it('a paste that won\'t fit is refused whole, the note and caret unchanged, and "0 left" in a full note', async () => {
    const full = 'a'.repeat(280);
    const field = open(full);
    await edit(field, `${full.slice(0, 150)}PASTED${full.slice(150)}`, 156);
    expect(field.value).toBe(full);
    expect(field.selectionStart).toBe(150);
    expect(counter()).toBe('0 left');
  });

  it('addendum: a refused paste with plenty of room shows "N left" at once, until an edit leaves more than 30 (GM r23)', async () => {
    const field = open('b'.repeat(180));
    expect(counter()).toBeNull();
    await edit(field, `${'b'.repeat(10)}${'P'.repeat(150)}${'b'.repeat(170)}`, 160);
    expect(field.value).toBe('b'.repeat(180));
    expect(counter()).toBe('100 left');
    // GM r23 item 3: the next edit that leaves more than 30 hides it again.
    await edit(field, 'b'.repeat(100), 100);
    expect(counter()).toBeNull();
    await edit(field, 'b'.repeat(270), 270);
    expect(counter()).toBe('10 left');
  });

  it('typing into a full note is still refused, the caret kept', async () => {
    const field = open(`${'a'.repeat(279)}Z`);
    await edit(field, `X${'a'.repeat(279)}Z`, 1);
    expect(field.value).toBe(`${'a'.repeat(279)}Z`);
    expect(field.selectionStart).toBe(0);
  });

  it('the counter is neutral, never red, whatever is left', () => {
    const sheet = readFileSync(join(__dirname, '../src/styles/prompt-dialog.css'), 'utf8');
    const rule = /\.prompt-dialog__counter \{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    expect(rule).toMatch(/color: var\(--sr-ink-light/);
    expect(sheet).not.toMatch(/prompt-dialog__counter[^{]*\{[^}]*(danger|error|#ff|red)/i);
  });
});

describe('review 12 NIT-1: the three pressed states ease back on release', () => {
  it('each control\'s own rule (not only :active) carries the transform, so letting go eases back', async () => {
    const { cascaded } = await import('./helpers/cssCascade');
    document.body.className = 'app-slava-restraint';
    try {
      for (const classes of [['editor-transport__btn', 'editor-transport__zoom-reset'], ['world-modal__icon-button', 'world-modal__camera-reset'],
        ['mask-painter__tool', 'mask-painter__tool--erase']]) {
        const button = document.createElement('button');
        button.className = classes.join(' ');
        document.body.appendChild(button);
        const styles = cascaded(button);
        button.remove();
        expect(styles.get('|transition')?.value, classes[1]).toMatch(/transform 220ms cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/);
        expect(styles.get(':active|transform')?.value, classes[1]).toBe('scale(0.96)');
      }
    } finally {
      document.body.className = '';
    }
  });
});
