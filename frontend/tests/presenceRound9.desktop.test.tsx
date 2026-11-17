/**
 * PR #204 round 9, GM r12 (check on shot 07): in the desktop app's two developer setups the
 * line says "this window" and ends "The notice below says why.", so the general notice under it
 * must be the desktop dev text, never the browser tab's ("This tab…", "Open the link Nebula
 * printed"). The reason comes from where it really does: the shell decides the launch's token
 * (desktop/person-token.mjs decidePersonToken), answers `person:token` with it
 * (registerPersonTokenHandler), and the renderer reads that answer (lib/personSession).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: () => {}, subscribe: () => () => {}, send: () => {}, disconnect: () => {} } }));
const { PersonRequiredBanner } = await import('../src/components/PersonRequiredBanner');
const { LineText } = await import('../src/components/LineText');
const session = await import('../src/lib/personSession');
const copy = await import('../src/lib/errorCopy');
const { notConnectedKind, resetLinesForTests } = await import('../src/lib/notConnectedLine');
// The shell's own code (plain ESM, no Electron import).
const shell = await import('../../desktop/person-token.mjs') as {
  decidePersonToken: (launch: { debugPort?: string; debugSwitches?: string[]; isDevelopment?: boolean; devOptIn?: string }) => { token: string | null; reason: string | null };
  registerPersonTokenHandler: (ipcMain: { handle: (channel: string, fn: (event: unknown) => unknown) => void }, person: { token: string | null; reason: string | null }, validate: (event: unknown) => boolean) => void;
};

/** A window whose preload bridge answers `person:token` through the shell's real handler. */
function desktopWindow(launch: Parameters<typeof shell.decidePersonToken>[0]) {
  const person = shell.decidePersonToken(launch);
  let answer: (event: unknown) => unknown = () => null;
  shell.registerPersonTokenHandler({ handle: (_channel, fn) => { answer = fn; } }, person, () => true);
  vi.stubGlobal('nebulaDesktop', { apiBaseUrl: 'http://127.0.0.1:56789', person: { token: async () => answer({}) } });
}

const banner = () => document.querySelector('.person-required');

beforeEach(() => { session.resetPersonSessionForTests(); resetLinesForTests(); });
afterEach(() => { cleanup(); session.notePersonPromoted(); vi.unstubAllGlobals(); session.resetPersonSessionForTests(); });

const DEV_NOTICES = {
  'debug-port': 'A debugging port is open, so Settings, proposals and chats are off.',
  'dev-renderer': 'Dev mode: the Vite renderer can’t use your token. Set NEBULA_DESKTOP_DEV_PERSON=1 to allow it.',
} as const;

describe('GM r12 (07): the general notice in the desktop app\'s dev setups', () => {
  for (const [reason, launch] of [
    ['debug-port', { debugPort: '9222' }],
    ['debug-port', { debugSwitches: ['remote-debugging-port'] }],
    ['dev-renderer', { isDevelopment: true }],
  ] as const) {
    it(`${reason} (${Object.keys(launch)[0]}): the notice is the dev text, and the line defers to it`, async () => {
      desktopWindow(launch);
      expect(await session.personToken()).toBeNull();
      expect(session.inDesktopShell()).toBe(true);
      expect(session.personUnavailableReason()).toBe(reason);
      // The line, from the real defaults (no staged desktop flag or reason).
      const line = copy.notConnectedBecause('load your agents');
      expect(line).toBe('Nebula couldn’t load your agents because this window isn’t connected as you. The notice below says why.');
      expect(notConnectedKind(line)).toBe('defers');
      render(<><PersonRequiredBanner /><p className="settings-row__error"><LineText text={line} /></p></>);
      act(() => session.reportPersonRequired());
      await waitFor(() => expect(banner()?.textContent).toContain(DEV_NOTICES[reason]));
      expect(banner()!.textContent).not.toMatch(/This tab|Open the link Nebula printed/);
      // A deferring line keeps the notice.
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
      expect(banner()).not.toBeNull();
      // Generate's lines defer the same way.
      expect(copy.generateRefusedCopy(true)).toBe('Nebula added the nodes to the canvas but couldn’t start the generation because this window isn’t connected as you. The notice below says why.');
      expect(copy.generateRefusedCopy(false)).toBe(`Nebula couldn’t start the generation. Its nodes weren’t added to the canvas. ${copy.PERSON_REQUIRED_DEV_COPY}`);
    });
  }

  it('the packaged app (a token the backend later refuses): the window\'s own notice and fix', async () => {
    desktopWindow({});
    expect(await session.personToken()).not.toBeNull();
    expect(session.personRequiredMessage()).toBe('This window isn’t connected as you. Quit Nebula and open it again.');
    expect(copy.notConnectedBecause('load your agents')).toBe('Nebula couldn’t load your agents because this window isn’t connected as you. Quit Nebula and open it again.');
    expect(copy.generateRefusedCopy(true)).toBe('Nebula added the nodes to the canvas but couldn’t start the generation because this window isn’t connected as you. Quit Nebula and open it again, then run them from the canvas.');
  });
});

describe('GM r13 (1): Generate after its nodes were added', () => {
  it('in a tab: GM\'s line exactly, a fix line, never "try again"', () => {
    const line = copy.generateRefusedCopy(true, false);
    expect(line).toBe('Nebula added the nodes to the canvas but couldn’t start the generation because this tab isn’t connected as you. Open the link Nebula printed when it started, then run them from the canvas.');
    expect(notConnectedKind(line)).toBe('fix');
    expect(line).not.toMatch(/try again/i);
    expect(copy.saysPersonRequired(line)).toBe(true);
  });

  it('every Generate line opens with GM r12\'s heading', () => {
    expect(copy.GENERATE_HEADING).toBe('Nebula couldn’t start the generation.');
    expect(copy.generateRefusedCopy(false, false).startsWith(copy.GENERATE_HEADING)).toBe(true);
  });
});
