/**
 * PR #204 round 14, review 11 held-calls LOW-5 (mutants C3 and C4 survived): lib/commonsApi send holds
 * a Commons call only on a hold that has lasted the held rule's 150 ms (personHeldSettled), never at
 * once and never while the tab is still starting. Two windows where a call must still go out, with
 * the stored token, and reach apiFetch:
 * - C4: before the socket's first answer (a tab still starting, unconfirmed but not held).
 * - C3: inside the first 150 ms of a hold (a quick reconnect).
 * The desktop shell relies on both: a 401 there re-resolves the token and retries (commonsApi call).
 */
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

const session = await import('../src/lib/personSession');
const { commonsApi, resetCommonsSessionForTests } = await import('../src/lib/commonsApi');

const TOKEN = 'stored-person-token-0123456789';
const STORED = JSON.stringify({ token: TOKEN, backend: 'http://127.0.0.1:8000' });
const commonsSent = () => net.sent.filter((request) => request.includes('/api/commons'));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  window.sessionStorage.clear();
  resetCommonsSessionForTests();
  net.sent = [];
  net.auth = [];
  window.sessionStorage.setItem('nebula.person', STORED);
});
afterEach(() => {
  session.notePersonPromoted();
  window.sessionStorage.clear();
  vi.useRealTimers();
});

describe('review 11 LOW-5: the Commons isn\'t held while starting or inside the first 150 ms of a hold', () => {
  it('C4: before the socket\'s first answer a Commons call goes out with the stored token', async () => {
    session.resetPersonSessionForTests({ unanswered: true });
    expect(session.personUnconfirmed()).toBe(true);
    expect(session.personGateHeld()).toBe(false);
    void commonsApi.status().catch(() => {});
    await flush();
    expect(commonsSent()).toEqual(['GET /api/commons/status']);
    expect(net.auth).toEqual([`Bearer ${TOKEN}`]);
  });

  it('C3: 100 ms into a hold a Commons call still goes out with the stored token', async () => {
    session.reportPersonRequired();
    vi.advanceTimersByTime(100);
    expect(session.personGateHeld()).toBe(true);
    expect(session.personHeldSettled()).toBe(false);
    void commonsApi.collections().catch(() => {});
    await flush();
    expect(commonsSent()).toEqual(['GET /api/commons/collections']);
    expect(net.auth).toEqual([`Bearer ${TOKEN}`]);
  });

  it('the boundary: once the hold has lasted 150 ms the same call is held, and nothing is sent', async () => {
    session.reportPersonRequired();
    vi.advanceTimersByTime(session.PERSON_HELD_SETTLE_MS);
    expect(session.personHeldSettled()).toBe(true);
    const held = commonsApi.collections();
    held.catch(() => {});
    await flush();
    expect(commonsSent()).toEqual([]);
    await expect(held).rejects.toMatchObject({ message: expect.stringMatching(/because this tab isn’t connected as you\./) });
    expect(window.sessionStorage.getItem('nebula.person')).toBe(STORED);
  });
});
