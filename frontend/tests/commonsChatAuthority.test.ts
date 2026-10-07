import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commonsChatAuthority } from '../src/lib/commonsChatAuthority';
import { resetCommonsSessionForTests } from '../src/lib/commonsApi';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', () => ({ apiFetch: api.fetch }));
beforeEach(() => { sessionStorage.clear(); history.replaceState({}, '', '/'); resetCommonsSessionForTests(); api.fetch.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Commons chat human authority', () => {
  it('keeps the existing chat envelope and never resolves Commons auth while off', async () => {
    const uiToken = vi.fn(); vi.stubGlobal('nebulaDesktop', { commons: { uiToken } });
    expect(await commonsChatAuthority(false, 'Example brand')).toEqual({});
    expect(uiToken).not.toHaveBeenCalled();
    expect(api.fetch).not.toHaveBeenCalled();
  });
  it('adds browser human token and normalized brand without calling a token endpoint', async () => {
    const humanToken = crypto.randomUUID();
    history.replaceState({}, '', `/#commons-token=${humanToken}`);
    expect(await commonsChatAuthority(true, '  Example brand  ')).toEqual({ brand: 'Example brand', commonsToken: humanToken });
    expect(location.hash).toBe('');
    expect(api.fetch).not.toHaveBeenCalled();
  });
  it('does not authorize a turn without an explicit human session', async () => {
    await expect(commonsChatAuthority(true, '')).rejects.toThrow('no UI session');
    expect(api.fetch).not.toHaveBeenCalled();
  });
  it('uses a fresh backend link instead of a cached expired token', async () => {
    const previous = crypto.randomUUID(); const next = crypto.randomUUID();
    sessionStorage.setItem('nebula.commons.token', previous);
    expect((await commonsChatAuthority(true, '')).commonsToken).toBe(previous);
    history.replaceState({}, '', `/#commons-token=${next}`);
    expect((await commonsChatAuthority(true, '')).commonsToken).toBe(next);
    expect(api.fetch).not.toHaveBeenCalled();
  });
});
