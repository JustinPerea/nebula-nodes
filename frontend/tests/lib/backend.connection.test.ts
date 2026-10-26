import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiFetch, getBackendBaseUrl } from '../../src/lib/backend';
import { ConnectionLostError } from '../../src/lib/errorCopy';

/**
 * error-copy (GM - Design, 2026-10-22): a request with no answer at all is
 * turned into words where every request is made, so no screen can show the
 * browser's own "Failed to fetch". The original stays as the error's cause;
 * it is still a TypeError, so code that tells a lost answer from a refusal
 * keeps working. The caller's own abort is not a lost connection and comes
 * back exactly as fetch threw it.
 */

const LOST = "Nebula's server isn't answering. Make sure it's running, then try again.";

beforeAll(async () => { await getBackendBaseUrl(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('apiFetch with no answer', () => {
  it.each(['GET', 'POST', 'PUT'])('a %s whose fetch rejects with a TypeError says the connection line', async (method) => {
    const original = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn(async () => { throw original; }));
    const error = await apiFetch('/api/moodboards/g1/edits', { method }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(LOST);
    expect((error as Error).cause).toBe(original);
  });

  it('the caller\'s own abort comes back unchanged', async () => {
    const controller = new AbortController();
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); throw abort; }));
    await expect(apiFetch('/api/commons/blobs/x', { signal: controller.signal })).rejects.toBe(abort);
  });

  it('an abort the caller didn\'t ask for is a lost connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted.', 'AbortError'); }));
    await expect(apiFetch('/api/commons/status')).rejects.toThrow(LOST);
  });

  it('an answer is still returned as it came, whatever its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    expect((await apiFetch('/api/commons/status')).status).toBe(503);
  });
});

describe('round 2: apiRequest names its action', () => {
  it('no answer: a ConnectionLostError under the heading, still a TypeError', async () => {
    const backend = await import('../../src/lib/apiRequest');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const error = await backend.apiRequest("Couldn't load your API keys.", '/api/settings').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionLostError);
    expect((error as Error).message).toBe(`Couldn't load your API keys. ${LOST}`);
  });

  it('a 503: heading + GM\'s line, the status kept; an allowed status comes back as it is', async () => {
    const backend = await import('../../src/lib/apiRequest');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const error = await backend.apiRequest("Couldn't load your API keys.", '/api/settings').catch((e: unknown) => e);
    expect((error as Error).message).toBe("Couldn't load your API keys. Nebula didn't respond. Try again.");
    expect((error as { status: number }).status).toBe(503);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    expect((await backend.apiRequest("Couldn't load the board.", '/api/moodboards/x', undefined, { allow: [404] })).status).toBe(404);
  });
});
