/**
 * PR #204 round 13 (review 10 held-calls MEDIUM-2, LOW-2 M20):
 * - A tab reloaded after a backend restart keeps its person token (sessionStorage: "a reload keeps
 *   it") and its socket refuses it, but this page was never promoted. The Commons held only on a
 *   demote seen on this page (personWasPromoted), so that tab sent its person-only reads with the
 *   old token (live: GET /api/commons/collections, 401 four times) and showed the worker's Start
 *   live. It now holds on any hold that has lasted the held rule's 150 ms (personHeldSettled):
 *   nothing is sent, there is no Start, and the lines are a never-connected tab's. The token stays
 *   as it was: whether a tab drops a token its socket refuses is not this change's to decide.
 * - M20: the Commons view's flag goes with the view. Unmounted while demoted, then promoted, a
 *   Commons call goes out (the view's flag no longer holds it).
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => ({ sent: [] as string[], auth: [] as string[] }));
vi.mock('../src/lib/backend', async (original) => {
  const real = await original<typeof import('../src/lib/backend')>();
  return {
    ...real,
    apiFetch: (path: string, init?: RequestInit) => {
      net.sent.push(`${String(init?.method ?? 'GET').toUpperCase()} ${path.split('?')[0]}`);
      net.auth.push(String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''));
      return new Promise<Response>(() => {}); // never answers: the test reads what was sent
    },
  };
});
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const session = await import('../src/lib/personSession');
const { commonsApi, resetCommonsSessionForTests } = await import('../src/lib/commonsApi');
const { useDemotedView } = await import('../src/hooks/useTabHeld');

const STORED = JSON.stringify({ token: 'stale-person-token-0123456789', backend: 'http://127.0.0.1:8000' });
const commonsSent = () => net.sent.filter((request) => request.includes('/api/commons'));
const settle = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); }); };
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); }); };
/** What the Commons says: its lines and every because line, in page order. */
const lines = () => [...document.querySelectorAll('[data-commons-line], [data-line-because]')].map((line) => line.textContent?.trim());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  window.sessionStorage.clear();
  resetCommonsSessionForTests(); // also the person session, and the view's flag
  net.sent = [];
  net.auth = [];
});
afterEach(() => {
  cleanup();
  act(() => session.notePersonPromoted());
  window.sessionStorage.clear();
  vi.useRealTimers();
});

/** A tab whose socket refused it, held for longer than the held rule's 150 ms. */
async function heldTab({ token }: { token: boolean }) {
  if (token) window.sessionStorage.setItem('nebula.person', STORED);
  act(() => session.reportPersonRequired());
  await settle(1000);
}

describe('a reloaded tab with a stored token its socket refuses (review 10 MEDIUM-2)', () => {
  it('the Commons sends nothing, has no Start, and says what a never-connected tab says; the token stays', async () => {
    await heldTab({ token: false });
    render(<CommonsView />);
    await flush();
    await settle(200);
    const neverConnected = lines();
    expect(neverConnected.length).toBeGreaterThan(0);
    cleanup();
    resetCommonsSessionForTests();

    await heldTab({ token: true });
    expect(session.personWasPromoted()).toBe(false);
    expect(session.holdsPersonCredential()).toBe(true);
    render(<CommonsView />);
    expect(commonsSent()).toEqual([]); // the first frame
    await flush();
    await settle(200);
    await flush();
    expect(commonsSent()).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(document.querySelector('[data-commons-line="not-connected"]')?.textContent)
      .toMatch(/^Nebula couldn’t .* because this tab isn’t connected as you\./);
    expect(lines()).toEqual(neverConnected);
    expect(window.sessionStorage.getItem('nebula.person')).toBe(STORED);
  });

  it('a Commons call made before any view renders is held too, and the token stays', async () => {
    await heldTab({ token: true });
    const calls = [commonsApi.collections(), commonsApi.status()];
    calls.forEach((call) => call.catch(() => {}));
    await flush();
    expect(commonsSent()).toEqual([]);
    for (const call of calls) {
      await expect(call).rejects.toMatchObject({ message: expect.stringMatching(/because this tab isn’t connected as you\./) });
    }
    expect(window.sessionStorage.getItem('nebula.person')).toBe(STORED);
  });

  it('inside the first 150 ms of the hold nothing switches yet (a quick reconnect); the promote sends with the token', async () => {
    window.sessionStorage.setItem('nebula.person', STORED);
    act(() => session.reportPersonRequired());
    await settle(100);
    expect(session.personHeldSettled()).toBe(false);
    act(() => session.notePersonPromoted());
    void commonsApi.collections().catch(() => {});
    await flush();
    expect(commonsSent()).toEqual(['GET /api/commons/collections']);
    expect(net.auth).toEqual(['Bearer stale-person-token-0123456789']);
  });
});

describe('the Commons view switches on any settled hold (useDemotedView)', () => {
  function Probe() {
    const { demoted, epoch } = useDemotedView();
    return <output data-demoted={String(demoted)} data-epoch={epoch} />;
  }
  const probe = () => document.querySelector('output')!;
  it('never promoted on this page: held past 150 ms it switches; the promote ends it with a new epoch', async () => {
    window.sessionStorage.setItem('nebula.person', STORED);
    render(<Probe />);
    act(() => session.reportPersonRequired());
    await settle(100);
    expect(probe().dataset).toMatchObject({ demoted: 'false', epoch: '0' });
    await settle(100);
    expect(session.personWasPromoted()).toBe(false);
    expect(probe().dataset).toMatchObject({ demoted: 'true', epoch: '0' });
    act(() => session.notePersonPromoted());
    expect(probe().dataset).toMatchObject({ demoted: 'false', epoch: '1' });
  });
});

describe('the Commons view\'s flag goes with the view (review 10 LOW-2, M20)', () => {
  it('unmounted while demoted, then promoted: a Commons call goes out', async () => {
    window.sessionStorage.setItem('nebula.person', STORED);
    act(() => { session.notePersonPromoted(); session.reportPersonRequired(); });
    await settle(1000);
    const view = render(<CommonsView />);
    await flush();
    expect(commonsSent()).toEqual([]);
    view.unmount();
    act(() => session.notePersonPromoted());
    void commonsApi.collections().catch(() => {});
    await flush();
    expect(commonsSent()).toEqual(['GET /api/commons/collections']);
  });
});
