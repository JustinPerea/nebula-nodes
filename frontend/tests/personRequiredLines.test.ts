/**
 * GM - Design, 2026-10-23 (Q116 a), for a tab that isn't connected as the
 * person, verbatim:
 *
 *   "This change needs your OK, and this tab isn't connected as you.
 *   Open the link Nebula printed when it started, then try again."
 *   "Use it for every person-only refusal, not just Krea billing. The agents'
 *   text stays behind Details."
 *
 * Round 2 (GM, 2026-10-23): "line 3 shouldn't depend on the notice being
 * there, since it can be dismissed", and the desktop app gets its own line 3
 * and banner, verbatim:
 *
 *   "This change needs your OK, and this window isn't connected as you. Quit
 *   Nebula and open it again, then try again."
 *   "This window isn't connected as you, so Settings, proposals and chats are
 *   locked. Quit Nebula and open it again."
 *
 * chosen by the app's existing flag (personSession's inDesktopShell(): the
 * preload bridge's apiBaseUrl). "The browser banner stays as I sent it."
 *
 * and the notice (PersonRequiredBanner) itself, round 4 (one line, since it
 * stays up): "This tab isn't connected as you. Open the link Nebula printed
 * when it started."
 *
 * A refusal is a person-only one by its `code` ("person_required", the person
 * gate's), never by its words. The backend's own text, written for agents,
 * stays on the error (`detail`) for the Details toggle and the console.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', () => ({ apiFetch, rewriteBackendAssetUrls: (value: unknown) => value }));

import * as errorCopy from '../src/lib/errorCopy';
import { ACCESS_LOST_COPY, RequestFailedError, failureCopy, requestError } from '../src/lib/errorCopy';
import { personCredential, personRequiredMessage, personUnavailableReason, resetPersonSessionForTests } from '../src/lib/personSession';
import { ExecutionStartRejectedError, executeNode } from '../src/lib/api';
import { connectKrea } from '../src/lib/kreaConnection';
import { acceptProposal } from '../src/lib/canvasProposals';
import { enhancePrompt } from '../src/lib/enhancePrompt';

const GM_LINE = "This change needs your OK, and this tab isn't connected as you. Open the link Nebula printed when it started, then try again.";
const APP_LINE = "This change needs your OK, and this window isn't connected as you. Quit Nebula and open it again, then try again.";
// GM, round 4 (2026-10-23), verbatim: the banners stay up, so each fits one line.
const APP_BANNER = "This window isn't connected as you. Quit Nebula and open it again.";
const BANNER = "This tab isn't connected as you. Open the link Nebula printed when it started.";
const BILLING = "zz1: Changing how a Krea node is billed (_kreaAuth) is the person's call, so it needs their OK. Leave _kreaAuth as it is, and propose the change instead with propose_change (`nebula propose`); the person accepts it on the canvas.";
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const personRequired = () => json({ detail: BILLING, code: 'person_required' }, 403);

const details = (error: unknown) =>
  (errorCopy as unknown as { failureDetails?: (error: unknown) => string | null }).failureDetails?.(error);

beforeEach(() => {
  apiFetch.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe("GM's line for a person-only refusal", () => {
  it('is the reason of any request refused with code person_required; the agents\' text stays on the error', async () => {
    const error = await requestError("Couldn't recover the project.", personRequired());
    expect(error.reason).toBe(GM_LINE);
    expect(error.message).toBe(`Couldn't recover the project. ${GM_LINE}`);
    expect(failureCopy(error)).toEqual({ heading: "Couldn't recover the project.", reason: GM_LINE });
    expect(error.detail).toBe(BILLING);
    expect(error.code).toBe('person_required');
    expect(details(error)).toBe(BILLING);
  });

  it('wins over a reason the caller wrote: the code decides, never the words', () => {
    const error = new RequestFailedError("Couldn't start the run.", 403,
      { detail: BILLING, reason: BILLING, code: 'person_required' });
    expect(error.reason).toBe(GM_LINE);
  });

  it('leaves every other refusal as it was, with nothing behind Details', async () => {
    const plain = await requestError("Couldn't recover the project.", json({ detail: BILLING }, 403));
    expect(plain.reason).toBe(BILLING);
    expect(details(plain)).toBeNull();
    const bare = await requestError("Couldn't recover the project.", json({}, 403));
    expect(bare.reason).toBe(ACCESS_LOST_COPY);
    // A person_required answer with no words of its own has nothing to hide.
    const wordless = await requestError("Couldn't recover the project.", json({ code: 'person_required' }, 403));
    expect(wordless.reason).toBe(GM_LINE);
    expect(details(wordless)).toBeNull();
  });

  it('a refused run start keeps the code, so the card can say it and hold the text behind Details', async () => {
    apiFetch.mockResolvedValue(personRequired());
    const refused = await executeNode([], [], 'n1').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ExecutionStartRejectedError);
    expect((refused as ExecutionStartRejectedError).reason).toBe(GM_LINE);
    expect((refused as ExecutionStartRejectedError).code).toBe('person_required');
    expect(details(refused)).toBe(BILLING);
  });

  it('a refused proposal accept keeps the code too', async () => {
    apiFetch.mockResolvedValue(json({ detail: 'Only the person can do this, from a Nebula canvas connected as them.',
      code: 'person_required' }, 403));
    const refused = await acceptProposal('p_a', 'key', {}).catch((error: unknown) => error);
    expect((refused as RequestFailedError).code).toBe('person_required');
    expect((refused as RequestFailedError).reason).toBe(GM_LINE);
  });

  it('Krea connection: the person gate\'s refusal says it, other refusals keep their line', async () => {
    apiFetch.mockResolvedValueOnce(personRequired());
    await expect(connectKrea()).rejects.toThrow(`Couldn't update the Krea connection. ${GM_LINE}`);
    apiFetch.mockResolvedValueOnce(json({ detail: 'Krea connection origin is not allowed' }, 403));
    await expect(connectKrea()).rejects.toThrow(`Couldn't update the Krea connection. ${ACCESS_LOST_COPY}`);
  });

  it('Enhance prompt says it too', async () => {
    apiFetch.mockResolvedValue(json({ detail: 'Only the person can do this', code: 'person_required' }, 403));
    await expect(enhancePrompt('x')).rejects.toThrow(GM_LINE);
  });

  it('a reason for an answer read by hand classifies by code as well', () => {
    const copyForAnswer = (errorCopy as unknown as {
      copyForAnswer?: (status: number, detail: unknown, code: string | null) => string;
    }).copyForAnswer;
    expect(typeof copyForAnswer).toBe('function');
    expect(copyForAnswer!(403, BILLING, 'person_required')).toBe(GM_LINE);
    expect(copyForAnswer!(403, BILLING, null)).toBe(BILLING);
    expect(copyForAnswer!(503, BILLING, 'person_required')).toBe("Nebula didn't respond. Try again.");
  });
});

describe("GM's banner line", () => {
  it('is the notice a browser tab shows when it isn\'t connected as the person', () => {
    expect(personRequiredMessage('not-connected')).toBe(BANNER);
  });

  it('keeps the desktop shell\'s own lines', () => {
    expect(personRequiredMessage('desktop-unavailable')).toBe(
      "Nebula couldn't confirm this window is yours, so Settings, proposals and chats are off. Quit Nebula and open it again.");
  });
});

/** The preload bridge the desktop shell exposes (desktop/preload.cjs): its
 * apiBaseUrl is what inDesktopShell() reads. */
function inTheApp(person?: { token: () => Promise<unknown> }) {
  Object.defineProperty(window, 'nebulaDesktop', {
    value: { apiBaseUrl: 'http://127.0.0.1:56789', wsBaseUrl: 'ws://127.0.0.1:56789', ...(person ? { person } : {}) },
    configurable: true, writable: true,
  });
}

describe("GM's app lines (round 2), chosen by the desktop flag", () => {
  beforeEach(() => resetPersonSessionForTests());
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).nebulaDesktop;
    resetPersonSessionForTests();
  });

  it('line 3 in the app is the window line, with the agents\' text still behind Details', async () => {
    inTheApp();
    const error = await requestError("Couldn't recover the project.", personRequired());
    expect(error.reason).toBe(APP_LINE);
    expect(error.message).toBe(`Couldn't recover the project. ${APP_LINE}`);
    expect(details(error)).toBe(BILLING);
    const written = new RequestFailedError("Couldn't start the run.", 403,
      { detail: BILLING, reason: BILLING, code: 'person_required' });
    expect(written.reason).toBe(APP_LINE);
  });

  it('every path that read line 3 reads the app line in the app', async () => {
    inTheApp();
    apiFetch.mockImplementation(async () => personRequired());
    const refused = await executeNode([], [], 'n1').catch((error: unknown) => error);
    expect((refused as ExecutionStartRejectedError).reason).toBe(APP_LINE);
    expect(details(refused)).toBe(BILLING);
    await expect(connectKrea()).rejects.toThrow(`Couldn't update the Krea connection. ${APP_LINE}`);
    await expect(enhancePrompt('x')).rejects.toThrow(APP_LINE);
    expect(errorCopy.copyForAnswer(403, BILLING, 'person_required')).toBe(APP_LINE);
    // Not a person-only refusal: unchanged in the app too.
    expect(errorCopy.copyForAnswer(403, BILLING, null)).toBe(BILLING);
  });

  it('a browser tab keeps the browser line 3', () => {
    expect(errorCopy.copyForAnswer(403, BILLING, 'person_required')).toBe(GM_LINE);
  });

  it("the app's banner, when the backend refuses the token the shell handed over", async () => {
    inTheApp({ token: vi.fn().mockResolvedValue({ ok: true, token: 'p'.repeat(43) }) });
    expect(await personCredential()).not.toBeNull();
    // The shell gave a token, so there is no shell reason: only the backend's refusal.
    expect(personUnavailableReason()).toBe('not-connected');
    expect(personRequiredMessage()).toBe(APP_BANNER);
    expect(personRequiredMessage('not-connected')).toBe(APP_BANNER);
  });

  // GM, round 3 (2026-10-23), verbatim: in the two developer setups line 3
  // points to the banner, which already gives the real fix.
  it('line 3 points to the banner with a debug port open or the dev renderer', async () => {
    const DEV_LINE = "This change needs your OK, and this window isn't connected as you. The notice below says why.";
    for (const error of ['DEBUG_PORT', 'DEV_RENDERER']) {
      resetPersonSessionForTests();
      inTheApp({ token: vi.fn().mockResolvedValue({ ok: false, error }) });
      expect(await personCredential()).toBeNull();
      expect(errorCopy.copyForAnswer(403, BILLING, 'person_required')).toBe(DEV_LINE);
      const written = new RequestFailedError("Couldn't start the run.", 403,
        { detail: BILLING, reason: BILLING, code: 'person_required' });
      expect(written.reason).toBe(DEV_LINE);
      expect(details(written)).toBe(BILLING);
    }
    // A normal launch keeps "Quit Nebula and open it again, then try again."
    resetPersonSessionForTests();
    inTheApp({ token: vi.fn().mockResolvedValue({ ok: true, token: 'p'.repeat(43) }) });
    expect(await personCredential()).not.toBeNull();
    expect(errorCopy.copyForAnswer(403, BILLING, 'person_required')).toBe(APP_LINE);
  });

  it("GM's one-line debug and dev-renderer banners (round 4)", () => {
    expect(personRequiredMessage('debug-port')).toBe(
      'Debug mode: a debugging port is open, so Settings, proposals and chats are off.');
    expect(personRequiredMessage('dev-renderer')).toBe(
      "Dev mode: the Vite renderer can't use your token. Set NEBULA_DESKTOP_DEV_PERSON=1 to allow it.");
  });

  it("the shell's own reasons keep their lines in the app, and the browser banner stays", async () => {
    inTheApp({ token: vi.fn().mockResolvedValue({ ok: false, error: 'DEBUG_PORT' }) });
    expect(await personCredential()).toBeNull();
    expect(personRequiredMessage()).toMatch(/^Debug mode: a debugging port is open/);
    expect(personRequiredMessage('desktop-unavailable')).toBe(
      "Nebula couldn't confirm this window is yours, so Settings, proposals and chats are off. Quit Nebula and open it again.");
    delete (window as unknown as Record<string, unknown>).nebulaDesktop;
    expect(personRequiredMessage('not-connected')).toBe(BANNER);
  });
});
