// PR #200 fix round 12 (GM r18).
// Q1: a note with too much hidden text gets a neutral toast that says only
// what to do, and the dialog stays open with the note as typed.
// Captures: the Settings remove-key confirm is filled once open; three
// neutral controls that had no pressed state take the toolbar's press.
// (Forget ID's frame is the ratchet's frameFindings.)
// Review 11: MEDIUM-1, marks that draw nothing are hidden text; LOW-1, a
// full note refuses a keystroke instead of dropping its end; NIT-1, a cut
// never lands inside an escape code a longer start keeps whole.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RequestFailedError } from '../src/lib/errorCopy';

const api = vi.hoisted(() => ({ createPin: vi.fn(), fetchPins: vi.fn(), deletePin: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
vi.mock('../src/lib/canvasPins', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/canvasPins')>(), ...api }));

const { HIDDEN_TEXT_CODE, HIDDEN_TEXT_COPY, MAX_PIN_TEXT, fitNote, noteLength, pinDisplayText } = await import('../src/lib/canvasPins');
const { PromptDialog } = await import('../src/components/PromptDialog');
const { PinComposer } = await import('../src/components/canvas/PinComposer');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');

const css = (file: string) => readFileSync(join(__dirname, '../src', file), 'utf8');
const hidden = () => new RequestFailedError("Couldn't save the note.", 422, {
  detail: 'This note has too much hidden text to save.', code: HIDDEN_TEXT_CODE });
const NOTE = `look here\x1b]0;${'h'.repeat(1200)}\x07`;

beforeEach(() => {
  useCanvasPinsStore.setState({ pins: [], composer: null, composerCanvas: null, removing: {}, error: null,
    errorProject: null, draft: '', drafts: {}, kept: [] });
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(cleanup);

describe('GM r18 Q1: too much hidden text', () => {
  it('the copy is the one line GM wrote, with no "Couldn\'t save the note." over it', () => {
    expect(HIDDEN_TEXT_COPY).toBe('This note has too much hidden text to save. Paste it as plain text, then try again.');
  });

  it('the store keeps the dialog open with the note as typed, and the toast is a notice', async () => {
    api.createPin.mockRejectedValue(hidden());
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    expect(await useCanvasPinsStore.getState().submit(NOTE)).toBe(false);
    const state = useCanvasPinsStore.getState();
    expect(state.composer).toEqual({ nodeId: 'n1' });
    expect(state.draft).toBe(NOTE);
    expect(state.error).toBe(HIDDEN_TEXT_COPY);
    // The open dialog holds it; no stale draft waits to come back after a send.
    expect(state.drafts).toEqual({});
  });

  it('sending it again as plain text clears the notice and sends', async () => {
    api.createPin.mockRejectedValueOnce(hidden()).mockImplementationOnce(async (text: string) => ({ id: 'pin_p', text,
      anchor: { nodeId: 'n1' }, position: null, status: 'open', createdAt: '2026-10-28T00:00:00+00:00', detached: false, reply: null }));
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    await useCanvasPinsStore.getState().submit(NOTE);
    expect(await useCanvasPinsStore.getState().submit('look here')).toBe(true);
    expect(useCanvasPinsStore.getState()).toMatchObject({ composer: null, error: null, drafts: {} });
  });

  it('the composer shows a neutral status toast over the open dialog, with the typed note still in the field', async () => {
    api.createPin.mockRejectedValue(hidden());
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<PinComposer />);
    const field = screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: NOTE } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send note' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    const toast = screen.getByRole('status');
    expect(toast).toHaveClass('canvas-pin-toast', 'canvas-pin-toast--notice');
    expect(toast).not.toHaveClass('canvas-pin-toast--error');
    expect(toast.textContent).toContain(HIDDEN_TEXT_COPY);
    expect(toast.textContent).not.toContain("Couldn't");
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement).value).toBe(NOTE);
  });

  it('the notice toast takes the kept note\'s neutral colours, never the error red', () => {
    const sheet = css('styles/canvasPins.css');
    const shared = /\.canvas-pin-toast--kept,\s*\.canvas-pin-toast--notice \{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    expect(shared).toMatch(/border-color: #333/);
    expect(shared).toMatch(/color: #d8d8d8/);
    expect(sheet).not.toMatch(/\.canvas-pin-toast--notice[^{]*\{[^}]*(danger|#ff|red)/i);
  });
});

describe('captures', () => {
  it('Settings: the open remove-key confirm is filled at rest, hovered and pressed, with near-black ink', () => {
    const sheet = css('styles/settings.css');
    const rest = /body\.app-slava-restraint \.settings__confirm--danger \{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    expect(rest).toMatch(/background: var\(--sr-danger-fill[,)]/);
    expect(rest).toMatch(/color: var\(--sr-on-danger[,)]/);
    const live = /\.settings__confirm--danger:hover:not\(:disabled\),\s*body\.app-slava-restraint \.settings__confirm--danger:active:not\(:disabled\) \{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    expect(live).toMatch(/background: var\(--sr-danger-fill-hover[,)]/);
    expect(live).toMatch(/color: var\(--sr-on-danger[,)]/);
  });

  it.each(['editor-transport__zoom-reset', 'world-modal__camera-reset', 'mask-painter__tool--erase'])(
    '%s has a pressed state: the toolbar\'s scale(0.96)', (name) => {
      const sheet = css('styles/slava-restraint.css');
      const rule = new RegExp(`body\\.app-slava-restraint \\.${name}:active:not\\(:disabled\\)[^{]*\\{([^}]*)\\}`).exec(sheet)?.[1] ?? '';
      expect(rule).toMatch(/transform: scale\(0\.96\)/);
    });

  it('the safeguards box around Forget ID is neutral in both skins', () => {
    const sheet = css('styles/run-history.css');
    const slava = /body\.app-slava-restraint \.run-history__safeguards \{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    expect(slava).toMatch(/var\(--sr-edge-strong/);
    expect(slava).not.toMatch(/warning|#f5c518/);
    const legacy = /body:not\(\.app-slava-restraint\) \.run-history__safeguards \{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    expect(legacy).not.toMatch(/#66471f|#2a2116|#e8c99e/);
  });
});

describe('review 11 MEDIUM-1: marks that draw nothing are hidden text', () => {
  // Case for case with the backend: agentPresenceFollowups.r12text.test.ts (the shared corpus).
  it('280 letters each carrying 32 selectors count 280 and show none of them', () => {
    const smuggled = Array.from({ length: MAX_PIN_TEXT }, (_, i) => String.fromCharCode(0x61 + (i % 26))
      + Array.from({ length: 32 }, (_, j) => String.fromCodePoint(0xe0100 + ((i * 32 + j) % 240))).join('')).join('');
    expect(pinDisplayText(smuggled)).toHaveLength(MAX_PIN_TEXT);
    expect(noteLength(smuggled)).toBe(MAX_PIN_TEXT);
  });
});

describe('review 11 NIT-1: fitNote never cuts inside an escape code a longer start keeps', () => {
  it('279 x, a colour code, "yz": keeps the whole code and "y"', () => {
    expect(fitNote(`${'x'.repeat(279)}\x1b[31myz`)).toBe(`${'x'.repeat(279)}\x1b[31my`);
    expect(fitNote(`${'x'.repeat(278)}\x1b[31mabc`)).toBe(`${'x'.repeat(278)}\x1b[31mab`);
  });
});

describe('review 11 LOW-1, GM r20 note 1: a full note refuses a keystroke; it never drops its end', () => {
  const full = `${'a'.repeat(279)}Z`;
  const NOTE_CAP = { max: MAX_PIN_TEXT, count: noteLength, showAt: 30 };

  it('the dialog: typing at the start of a full note leaves it whole, the caret where it was', async () => {
    const request = { label: 'Note for agents', initial: full, resolve: () => {} };
    render(<PromptDialog request={request} onDone={() => {}} cap={NOTE_CAP} multiline confirmLabel="Send note" />);
    const field = screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(field, `X${full}`);
      field.setSelectionRange(1, 1);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(field.value).toBe(full);
    expect(field.selectionStart).toBe(0);
    await act(async () => {
      setter.call(field, `${full.slice(0, 100)}M${full.slice(100)}`);
      field.setSelectionRange(101, 101);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(field.value).toBe(full);
    expect(field.value.endsWith('Z')).toBe(true);
    expect(field.selectionStart).toBe(100);
  });
});

describe('GM r19 answer 2: a running leave past the limit plays out, with a dev warning', () => {
  const withLeave = (endTime: number) => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const animation = Object.assign(new EventTarget(), { animationName: 'notice-surface-out', playState: 'running', pending: false,
      currentTime: 0, playbackRate: 1, effect: { getComputedTiming: () => ({ endTime }) }, cancel: () => {} });
    element.getAnimations = () => [animation as unknown as Animation];
    return { element, animation };
  };

  it('a 6 s leave warns once in development and ends when it ends, not cut at 2.3 s', async () => {
    const { watchLeave, STALL_LIMIT_MS } = await import('../src/lib/noticeLeave');
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { element, animation } = withLeave(6000);
      const end = vi.fn();
      const stop = watchLeave(element, end);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/6000 ms, past the 2300 ms limit/);
      vi.advanceTimersByTime(STALL_LIMIT_MS + 500);
      expect(end).not.toHaveBeenCalled();
      animation.playState = 'finished';
      vi.advanceTimersByTime(6000);
      expect(end).toHaveBeenCalledTimes(1);
      stop();
      element.remove();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a leave inside the limit says nothing', async () => {
    const { watchLeave } = await import('../src/lib/noticeLeave');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { element } = withLeave(300);
      const stop = watchLeave(element, () => {});
      expect(warn).not.toHaveBeenCalled();
      stop();
      element.remove();
    } finally {
      warn.mockRestore();
    }
  });

  it('the warning is development only: production builds drop it', () => {
    expect(css('lib/noticeLeave.ts')).toMatch(/if \(import\.meta\.env\.DEV && planned > STALL_LIMIT_MS\)/);
  });
});
