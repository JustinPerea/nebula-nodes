/**
 * PR #204 round 6 (review 4 LOW-1, NIT-2, survivor M16): every answer apiFetch returns carries the
 * promote count its request went out under, the discovery replay's too, and gets the one
 * person-gate check; "sent before the promote" is read when asked, not when the answer landed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const refusal = () => new Response(JSON.stringify({ detail: 'Only the person can do this.', code: 'person_required' }),
  { status: 403, headers: { 'Content-Type': 'application/json' } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.localStorage.removeItem('nebula:backendBaseUrl');
});

describe('the discovery replay is stamped and checked like the first answer', () => {
  it('a read whose first try lost the connection, answered person_required by the rediscovered backend', async () => {
    vi.resetModules();
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '');
    vi.stubEnv('VITE_NEBULA_BACKEND_PORTS', '');
    window.localStorage.setItem('nebula:backendBaseUrl', 'http://old.example:8000');
    let phase: 'discover' | 'read' = 'discover';
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        if (phase === 'discover' && url === 'http://old.example:8000/api/health') return ok({ status: 'ok', app: 'nebula' });
        if (phase === 'read' && url === 'http://localhost:8000/api/health') return ok({ status: 'ok', app: 'nebula' });
        return new Response('{}', { status: 503 });
      }
      if (url === 'http://old.example:8000/api/read') throw new TypeError('connection reset after send');
      if (url === 'http://localhost:8000/api/read') return refusal();
      return new Response('{}', { status: 503 });
    }));
    const backend = await import('../../src/lib/backend');
    const session = await import('../../src/lib/personSession');
    session.resetPersonSessionForTests();
    await backend.getBackendBaseUrl();
    phase = 'read';
    const response = await backend.apiFetch('/api/read');
    expect(response.status).toBe(403);
    expect(session.sentUnderPromote(response)).toBe(session.personPromotions());
    await flush();
    expect(session.personGateHeld()).toBe(true); // the one check ran on the replay's answer
    session.notePersonPromoted();
    expect(session.sentBeforePromote(response)).toBe(true); // read when asked
  });
});

describe('review 4 LOW-1: the stamp is read against the promote when it is asked', () => {
  it('a promote while the refusal\'s body is parsed: the old state\'s answer holds nothing', async () => {
    vi.resetModules();
    const backend = await import('../../src/lib/backend');
    const session = await import('../../src/lib/personSession');
    session.resetPersonSessionForTests();
    vi.stubGlobal('fetch', vi.fn(async () => refusal()));
    await backend.apiFetch('/api/settings', { method: 'PUT', body: '{}' });
    session.notePersonPromoted(); // after the answer, before its body is read
    await flush();
    expect(session.personGateHeld()).toBe(false);
  });

  it('parsed before the promote, registered after it: the line clears at once', async () => {
    vi.resetModules();
    const backend = await import('../../src/lib/backend');
    const session = await import('../../src/lib/personSession');
    const { requestError } = await import('../../src/lib/errorCopy');
    const { clearRefusedOnPromote } = await import('../../src/lib/clearsOnPromote');
    session.resetPersonSessionForTests();
    vi.stubGlobal('fetch', vi.fn(async () => refusal()));
    const response = await backend.apiFetch('/api/settings', { method: 'PUT', body: '{}' });
    const error = await requestError("Couldn't save the settings.", response);
    expect(error.sentBeforePromote).toBe(false);
    session.notePersonPromoted();
    const clear = vi.fn();
    clearRefusedOnPromote(error, clear);
    await flush();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
