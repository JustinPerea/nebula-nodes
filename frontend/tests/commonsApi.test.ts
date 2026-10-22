import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../src/lib/backend', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  backendUrlSync: (p: string) => `http://127.0.0.1:8000${p}`,
}));

import { commonsApi, commonsEvaluationApi, filtersToRequest, resetCommonsSessionForTests } from '../src/lib/commonsApi';
import { EMPTY_FILTERS } from '../src/lib/commonsTypes';
import { CommonsRequestError } from '../src/lib/commonsRequestError';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('commonsApi', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    sessionStorage.setItem('nebula.commons.token', crypto.randomUUID());
    history.replaceState({}, '', '/');
    apiFetch.mockReset();
    resetCommonsSessionForTests();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('uses the desktop bridge without minting over HTTP', async () => {
    const token = crypto.randomUUID();
    const uiToken = vi.fn().mockResolvedValue({ ok: true, token });
    vi.stubGlobal('nebulaDesktop', { apiBaseUrl: 'http://127.0.0.1:56789', person: { token: uiToken } });
    apiFetch.mockImplementation(async () => json({ results: [] }));
    await commonsApi.search({ query: 'grid', filters: {} });
    await commonsApi.search({ query: 'type', filters: {} });
    expect(uiToken).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls.every(([p]) => p !== '/api/commons/session')).toBe(true);
    expect(apiFetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('moves the dev fragment into session storage and removes it from history', async () => {
    const token = crypto.randomUUID();
    history.replaceState({}, '', `/#commons-token=${token}`);
    apiFetch.mockResolvedValue(json({}));
    await commonsApi.status();
    expect(JSON.parse(sessionStorage.getItem('nebula.person')!)).toEqual({ token, backend: 'http://127.0.0.1:8000' });
    expect(sessionStorage.getItem('nebula.commons.token')).toBeNull();
    expect(location.hash).toBe('');
    expect(apiFetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('re-resolves once on 401 and surfaces the entry instructions', async () => {
    const uiToken = vi.fn()
      .mockResolvedValueOnce({ ok: true, token: crypto.randomUUID() })
      .mockResolvedValueOnce({ ok: true, token: crypto.randomUUID() });
    vi.stubGlobal('nebulaDesktop', { apiBaseUrl: 'http://127.0.0.1:56789', person: { token: uiToken } });
    apiFetch.mockImplementation(async () => json({ detail: 'invalid UI session token' }, 401));
    await expect(commonsApi.status()).rejects.toThrow('use a fresh Commons dev link from the backend terminal');
    expect(uiToken).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[0][1].headers.Authorization).not.toBe(apiFetch.mock.calls[1][1].headers.Authorization);
  });

  it('stops sending a forgotten browser session after two rejected requests', async () => {
    apiFetch.mockImplementation(async () => json({ detail: 'invalid UI session token' }, 401));
    await expect(commonsApi.status()).rejects.toThrow('no UI session');
    expect(sessionStorage.getItem('nebula.commons.token')).toBeNull();
    expect(sessionStorage.getItem('nebula.person')).toBeNull();
    await expect(commonsApi.status()).rejects.toThrow('no UI session');
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  // The Commons' leave popover offers a save again only when it could work:
  // the error carries the answer's status (none for a lost connection).
  it('throws a CommonsRequestError carrying the status of a refused request', async () => {
    apiFetch.mockResolvedValueOnce(json({ detail: 'Labels changed in another window. Reload before saving.' }, 409));
    const conflict = await commonsApi.status().catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(CommonsRequestError);
    expect(conflict).toMatchObject({ status: 409, message: 'Labels changed in another window. Reload before saving.' });
    apiFetch.mockResolvedValueOnce(json({ detail: 'database is locked' }, 503));
    expect(await commonsApi.status().catch((error: unknown) => error)).toMatchObject({ status: 503 });
    apiFetch.mockImplementation(async () => json({ detail: 'invalid UI session token' }, 401));
    const session = await commonsApi.status().catch((error: unknown) => error);
    expect(session).toBeInstanceOf(CommonsRequestError);
    expect(session).toMatchObject({ status: 401 });
    sessionStorage.clear();
    expect(await commonsApi.status().catch((error: unknown) => error)).toMatchObject({ status: 401 });
  });

  it('makes no request from a desktop window that may not have the token', async () => {
    const token = vi.fn().mockResolvedValue({ ok: false, error: 'DEBUG_PORT' });
    vi.stubGlobal('nebulaDesktop', { apiBaseUrl: 'http://127.0.0.1:56789', person: { token } });
    await expect(commonsApi.status()).rejects.toThrow('no UI session');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('does not make a request without human authority', async () => {
    sessionStorage.clear();
    await expect(commonsApi.status()).rejects.toThrow('use a fresh Commons dev link from the backend terminal');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('fetches blob bytes with human authorization', async () => {
    apiFetch.mockResolvedValue(new Response('pixels', { headers: { 'content-type': 'image/png' } }));
    const blob = await commonsApi.blob('/api/commons/blobs/example.png');
    expect(await blob.text()).toBe('pixels');
    expect(apiFetch.mock.calls[0][1].headers.Authorization).toMatch(/^Bearer /);
  });

  it('turns an edit into a correction operation', async () => {
    apiFetch.mockResolvedValue(json({ id: 'cor_1' }));
    await commonsApi.correct('ast_1', { field_path: 'layout.value', op: 'set', value: 'grid', reason: 'cells align' });
    const [path, init] = apiFetch.mock.calls.at(-1)!;
    expect(path).toBe('/api/commons/assets/ast_1/corrections');
    expect(JSON.parse(init.body as string)).toEqual({ field_path: 'layout.value', op: 'set', value: 'grid', reason: 'cells align' });
  });

  it('surfaces the backend reason on errors', async () => {
    apiFetch.mockResolvedValue(json({ detail: 'bad filters: unknown axis' }, 422));
    await expect(commonsApi.search({ query: '', filters: {} })).rejects.toThrow('bad filters: unknown axis');
  });
});

describe('commonsEvaluationApi.close', () => {
  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem('nebula.commons.token', crypto.randomUUID());
    apiFetch.mockReset();
    resetCommonsSessionForTests();
  });

  it('posts the revision with an explicit not-blind acknowledgement', async () => {
    apiFetch.mockImplementation(async () => json({ state: 'closed' }));
    await commonsEvaluationApi.close(3);
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe('/api/commons/evaluation/close');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ revision: 3, acknowledge_not_blind: true });
  });
});

describe('filtersToRequest', () => {
  it('drops empty filters and keeps set ones', () => {
    expect(filtersToRequest(EMPTY_FILTERS)).toEqual({ query: '', filters: {} });
    const req = filtersToRequest({
      ...EMPTY_FILTERS, query: 'calm ui', axes: { quiet_loud: [-1, -0.4] }, keywords: ['minimal'],
      paletteHex: '#1f6feb', paletteDeltaE: 8, role: 'avoid', correctedOnly: true,
    });
    expect(req).toEqual({
      query: 'calm ui',
      filters: { axes: { quiet_loud: [-1, -0.4] }, keywords: ['minimal'],
        palette_near: { hex: '#1f6feb', max_delta_e: 8 }, role: 'avoid', corrected_only: true },
    });
  });
});
