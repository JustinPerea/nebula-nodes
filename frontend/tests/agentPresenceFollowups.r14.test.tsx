// PR #200 fix round 14 (GM r22).
// Q1: the person gate's 403 keeps its own line, "Notes can only be added from
// the Nebula canvas.", with no "try again", for a request that isn't the
// canvas's own (agent_refused); a tab not connected as the person
// (person_required) reads the banner's person-only line (review 13 L-1, GM r23). Q2: the pin card's status edge is
// its own element, the only thing near Delete note in the presence colour
// (the ratchet's half is agentPresenceFollowups.ratchet.test.ts). Q3: the
// dialog lets both 280-character emoji notes through; the backend saves them
// (backend/tests/test_pin_text_r14.py).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RequestFailedError, personRequiredCopy } from '../src/lib/errorCopy';
import corpus from '../../backend/tests/fixtures/pin_text_cases.json';

const api = vi.hoisted(() => ({ createPin: vi.fn(), fetchPins: vi.fn(), deletePin: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
vi.mock('../src/lib/canvasPins', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/canvasPins')>(), ...api }));

const { MAX_PIN_TEXT, PIN_REFUSAL_COPY, noteLength, pinRefusalLine, pinTextReady } = await import('../src/lib/canvasPins');
const { PromptDialog } = await import('../src/components/PromptDialog');
const { PinComposer } = await import('../src/components/canvas/PinComposer');
// The app draws its notices in the notice region, which stays usable beside
// an open dialog (ModalPortal isolates everything else, GM PR #203 r13).
const { NoticeRegion } = await import('../src/components/NoticeRegion');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');

const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
const STRAY = '\u{1F600}️';
const refused = (status: number, code?: string) => new RequestFailedError("Couldn't add the pin.", status, { detail: 'x', code: code ?? null });

beforeAll(() => pinTextReady);
beforeEach(() => {
  useCanvasPinsStore.setState({ pins: [], composer: null, composerCanvas: null, removing: {}, error: null, errorProject: null,
    draft: '', drafts: {}, kept: [] });
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(cleanup);

describe('GM r22 Q1: the person gate keeps its own line', () => {
  it('reads "Notes can only be added from the Nebula canvas." with no "try again"', () => {
    expect(PIN_REFUSAL_COPY.canvasOnly).toBe('Notes can only be added from the Nebula canvas.');
    expect(PIN_REFUSAL_COPY.canvasOnly).not.toMatch(/try again/i);
    expect(pinRefusalLine(refused(403, 'person_required'), 'add')).toBe(personRequiredCopy());
    expect(pinRefusalLine(refused(403, 'agent_refused'), 'add')).toBe(PIN_REFUSAL_COPY.canvasOnly);
    expect(pinRefusalLine(refused(422), 'add')).toBe(PIN_REFUSAL_COPY.addRefused);
  });

  it('the composer shows it in the neutral status, the note still in the open dialog', async () => {
    api.createPin.mockRejectedValue(refused(403, 'agent_refused'));
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<><NoticeRegion /><PinComposer /></>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for agents' }), { target: { value: 'warmer please' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send note' })); });
    const toast = screen.getByRole('status');
    expect(toast).toHaveClass('canvas-pin-toast--notice');
    expect(toast.textContent).toBe(`${PIN_REFUSAL_COPY.canvasOnly}×`);
    expect((screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement).value).toBe('warmer please');
  });
});

describe('GM r22 Q2: the status edge is its own element', () => {
  it('PinLayer draws it inside the card; only it takes the pin and author colours', () => {
    const layer = readFileSync(join(__dirname, '../src/components/canvas/PinLayer.tsx'), 'utf8');
    expect(layer).toMatch(/<span className="canvas-pin__edge" aria-hidden="true" \/>/);
    const sheet = readFileSync(join(__dirname, '../src/styles/canvasPins.css'), 'utf8');
    expect(/\.canvas-pin__edge \{[^}]*top: -1px;[^}]*bottom: -1px;[^}]*background: var\(--pin-color\);/s.test(sheet)).toBe(true);
    expect(sheet).toMatch(/\.canvas-pin--resolved \.canvas-pin__edge \{\s*background: var\(--agent-color, #5b9dff\);/);
    // The card itself has no presence colour any more: no amber border-left, nothing on Delete.
    const card = /\.canvas-pin__card \{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    expect(card).not.toMatch(/--pin-color|--agent-color|border-left/);
    for (const [selector, body] of sheet.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (/--pin-color|--agent-color/.test(body) && !/^\s*:root|\.canvas-pin \{/.test(selector)) {
        expect(selector.trim(), body).toMatch(/canvas-pin__edge|canvas-pin__badge|canvas-pin__agent|canvas-pin--resolved \.canvas-pin__badge|^\.canvas-pin$/);
      }
    }
  });
});

describe('GM r22 Q3: both 280-character emoji notes fit the dialog', () => {
  const CAP = { max: MAX_PIN_TEXT, count: noteLength, showAt: 30 };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  it.each([
    ['280 emoji, each with a stray FE0F', STRAY.repeat(280)],
    ['280 families', FAMILY.repeat(280)],
  ])('%s: 280 characters, "0 left", accepted whole', async (_name, note) => {
    expect(noteLength(note)).toBe(280);
    render(<PromptDialog request={{ label: 'Note for agents', initial: '', resolve: () => {} }} onDone={() => {}} cap={CAP} multiline confirmLabel="Send note" />);
    const field = screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
    await act(async () => { setter.call(field, note); field.dispatchEvent(new Event('input', { bubbles: true })); await Promise.resolve(); });
    expect(field.value).toBe(note);
    const counter = document.querySelector('.prompt-dialog__counter');
    expect(counter?.hasAttribute('data-shown') && counter.textContent).toBe('0 left');
  });

  it('every corpus case the backend saves fits the dialog\'s 280', () => {
    const cases = (corpus as { cases: Array<{ name: string; typed: string; saves?: boolean }> }).cases;
    const blocked = cases.filter((c) => c.saves && noteLength(c.typed) > MAX_PIN_TEXT).map((c) => c.name);
    expect(blocked).toEqual([]);
    expect(cases.filter((c) => c.name.startsWith('GM r22')).every((c) => c.saves)).toBe(true);
  });
});
