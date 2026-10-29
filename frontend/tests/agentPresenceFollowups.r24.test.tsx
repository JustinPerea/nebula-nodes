// PR #200 fix round 15, GM r24: the person-gate banner and the note dialog.
// - With the banner showing, a send the gate refused says only "Your note
//   wasn’t added." (the banner carries the fix); with no banner, the full
//   Q116a line.
// - While the banner shows (up as the dialog opens, or arriving while it is
//   open), Send note is disabled in the shared style with the reason "You can
//   send notes when this tab is connected as you."
// - "isn’t" and the other contractions take ’ at the source, so every caller
//   gets it.
// - The banner is neutral, in the shared notice colours.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PERSON_REQUIRED_APP_COPY, PERSON_REQUIRED_COPY, PERSON_REQUIRED_DEV_COPY, RequestFailedError } from '../src/lib/errorCopy';

const api = vi.hoisted(() => ({ createPin: vi.fn(), fetchPins: vi.fn(), deletePin: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
vi.mock('../src/lib/canvasPins', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/canvasPins')>(), ...api }));

const { PIN_REFUSAL_COPY, pinTextReady } = await import('../src/lib/canvasPins');
const { PinComposer } = await import('../src/components/canvas/PinComposer');
const { PersonRequiredBanner } = await import('../src/components/PersonRequiredBanner');
const { useCanvasPinsStore } = await import('../src/store/canvasPinsStore');
const session = await import('../src/lib/personSession');

const gate = () => new RequestFailedError("Couldn't add the pin.", 403, { detail: 'x', code: 'person_required' });
const field = () => screen.getByRole('textbox', { name: 'Note for agents' }) as HTMLTextAreaElement;
const send = () => screen.getByRole('button', { name: 'Send note' }) as HTMLButtonElement;
const toastText = () => document.querySelector('.canvas-pin-toast--notice')?.firstElementChild?.textContent ?? null;
const bannerText = () => document.querySelector('.person-required')?.firstElementChild?.textContent ?? null;

beforeAll(() => pinTextReady);
beforeEach(() => {
  useCanvasPinsStore.setState({ pins: [], composer: null, composerCanvas: null, removing: {}, error: null, errorProject: null,
    errorPersonGate: false, draft: '', drafts: {}, kept: [], targetGone: false, tooLongRefusals: 0 });
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => { cleanup(); session.resetPersonSessionForTests(); });

describe('GM r24: the toast beside the person-gate banner', () => {
  it('a gate found on send: the banner says the fix, the toast only "Your note wasn’t added.", once', async () => {
    // As apiFetch does: the 403's code raises the banner, then the request fails.
    api.createPin.mockImplementation(async () => { session.reportPersonRequired(); throw gate(); });
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<><PersonRequiredBanner /><PinComposer /></>);
    fireEvent.change(field(), { target: { value: 'warmer please' } });
    await act(async () => { fireEvent.click(send()); });
    expect(bannerText()).toBe('This tab isn’t connected as you. Open the link Nebula printed when it started.');
    expect(toastText()).toBe('Your note wasn’t added.');
    expect(PIN_REFUSAL_COPY.notAdded).toBe('Your note wasn’t added.');
    expect(field().value).toBe('warmer please');
    // The banner's up now, so Send note waits too.
    expect(send().disabled).toBe(true);
    expect(send().title).toBe('You can send notes when this tab is connected as you.');
    const live = [...document.querySelectorAll('[role="status"], [aria-live]')].filter((el) => el.textContent?.includes('Your note wasn’t added.'));
    expect(live).toHaveLength(1);
  });

  it('with no banner showing (dismissed), the toast is the full Q116a line; Send note stays held (GM r27 item 2)', async () => {
    api.createPin.mockImplementation(async () => { session.reportPersonRequired(); throw gate(); });
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<><PersonRequiredBanner /><PinComposer /></>);
    fireEvent.change(field(), { target: { value: 'warmer please' } });
    await act(async () => { fireEvent.click(send()); });
    await act(async () => { fireEvent.click(document.querySelector('.person-required button[aria-label="Dismiss"]')!); });
    expect(bannerText()).toBeNull();
    expect(toastText()).toBe(PERSON_REQUIRED_COPY);
    // × hides the banner, not the condition: Send note waits with its reason.
    expect(send().disabled).toBe(true);
    expect(send().title).toBe(PIN_REFUSAL_COPY.sendWhenConnected);
    await act(async () => { fireEvent.submit(field().closest('form')!); });
    expect(api.createPin).toHaveBeenCalledTimes(1);
  });

  it('a surface with no banner at all says the full line', async () => {
    api.createPin.mockRejectedValue(gate());
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<PinComposer />);
    fireEvent.change(field(), { target: { value: 'warmer please' } });
    await act(async () => { fireEvent.click(send()); });
    expect(toastText()).toBe(PERSON_REQUIRED_COPY);
  });
});

describe('GM r24: Send note waits while the banner shows', () => {
  it('banner up as the dialog opens: disabled with the lock reason, Enter sends nothing, no toast; Cancel live', async () => {
    render(<><PersonRequiredBanner /><PinComposer /></>);
    act(() => session.reportPersonRequired());
    act(() => useCanvasPinsStore.getState().compose({ nodeId: 'n1' }));
    fireEvent.change(field(), { target: { value: 'a note' } });
    expect(send().disabled).toBe(true);
    expect(send().title).toBe(PIN_REFUSAL_COPY.sendWhenConnected);
    await act(async () => { fireEvent.submit(field().form!); });
    expect(api.createPin).not.toHaveBeenCalled();
    expect(toastText()).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled();
    // Connected: Send note is live again once the server promotes this tab
    // (GM r29 item 3, fix round 19); a link taken in alone isn't enough.
    act(() => { window.dispatchEvent(new CustomEvent('nebula:person-connected')); });
    expect(send().disabled).toBe(true);
    act(() => session.notePersonPromoted());
    expect(send().disabled).toBe(false);
  });

  it('banner arriving while the dialog is open disables it then', () => {
    useCanvasPinsStore.getState().compose({ nodeId: 'n1' });
    render(<><PersonRequiredBanner /><PinComposer /></>);
    expect(send().disabled).toBe(false);
    act(() => session.reportPersonRequired());
    expect(send().disabled).toBe(true);
    expect(send().title).toBe('You can send notes when this tab is connected as you.');
  });
});

describe('GM r24: ’ at the source', () => {
  it('every person-gate line takes ’, never a straight quote', () => {
    for (const line of [PERSON_REQUIRED_COPY, PERSON_REQUIRED_APP_COPY, PERSON_REQUIRED_DEV_COPY,
      session.personRequiredMessage('debug-port'), session.personRequiredMessage('dev-renderer'),
      session.personRequiredMessage('untrusted-sender'), session.personRequiredMessage(null as never)]) {
      expect(line, line).not.toContain("'");
    }
    expect(PERSON_REQUIRED_COPY).toBe('This change needs your OK, and this tab isn’t connected as you. Open the link Nebula printed when it started, then try again.');
  });
});

describe('GM r24: the banner is neutral', () => {
  it('draws in the shared neutral notice colours, never orange-red, and no skin overrides it', () => {
    const app = readFileSync(join(__dirname, '../src/App.css'), 'utf8');
    const rule = /\n\.person-required \{([^}]*)\}/.exec(app)?.[1] ?? '';
    expect(rule).toMatch(/border: 1px solid var\(--notice-neutral-edge, #333\)/);
    expect(rule).toMatch(/background: var\(--notice-neutral-fill, #1a1a1a\)/);
    expect(rule).toMatch(/color: var\(--notice-neutral-ink, #d8d8d8\)/);
    expect(rule).not.toMatch(/ffb49f|32 16 13|accent|danger|warning/i);
    const region = readFileSync(join(__dirname, '../src/styles/noticeRegion.css'), 'utf8');
    expect(region).toMatch(/--notice-neutral-fill: #1a1a1a;[\s\S]*--notice-neutral-edge: #333;[\s\S]*--notice-neutral-ink: #d8d8d8;/);
    const skin = readFileSync(join(__dirname, '../src/styles/slava-restraint.css'), 'utf8');
    expect(skin).not.toMatch(/person-required/);
  });
});
