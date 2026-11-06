import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatAuthority } from '../src/lib/commonsChatAuthority';
import { resetCommonsSessionForTests } from '../src/lib/commonsApi';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/lib/backend', async (original) => ({ ...await original<typeof import('../src/lib/backend')>(), apiFetch: api.fetch }));
const SOCKET = 'ws://127.0.0.1:8000/ws/chat';
beforeEach(() => { sessionStorage.clear(); history.replaceState({}, '', '/'); resetCommonsSessionForTests(); api.fetch.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('chat authority', () => {
  it('sends no token and no brand when the tab is not connected and Commons is off', async () => {
    expect(await chatAuthority(SOCKET, false, 'Example brand')).toEqual({});
    expect(api.fetch).not.toHaveBeenCalled();
  });
  it('carries the person token on every turn, with or without Commons', async () => {
    const token = crypto.randomUUID();
    history.replaceState({}, '', `/#nebula-person=${token}&backend=http://127.0.0.1:8000`);
    expect(await chatAuthority(SOCKET, false, 'Example brand')).toEqual({ personToken: token });
    expect(location.hash).toBe('');
    expect(await chatAuthority(SOCKET, true, '  Example brand  ')).toEqual({ brand: 'Example brand', personToken: token });
    expect(api.fetch).not.toHaveBeenCalled();
  });
  it('keeps the token away from a chat socket on another backend', async () => {
    history.replaceState({}, '', `/#nebula-person=${crypto.randomUUID()}&backend=http://127.0.0.1:8000`);
    expect(await chatAuthority('ws://127.0.0.1:9999/ws/chat', false, '')).toEqual({});
    await expect(chatAuthority('ws://127.0.0.1:9999/ws/chat', true, '')).rejects.toThrow('Nebula couldn’t send the message because this tab isn’t connected as you. Open the link Nebula printed when it started.');
  });
  it('does not authorize a Commons turn without the person', async () => {
    await expect(chatAuthority(SOCKET, true, '')).rejects.toThrow('Nebula couldn’t send the message because this tab isn’t connected as you. Open the link Nebula printed when it started.');
    expect(api.fetch).not.toHaveBeenCalled();
  });
  it('uses a fresh backend link instead of a stored older token', async () => {
    const previous = crypto.randomUUID(); const next = crypto.randomUUID();
    sessionStorage.setItem('nebula.person', JSON.stringify({ token: previous, backend: 'http://127.0.0.1:8000' }));
    expect((await chatAuthority(SOCKET, true, '')).personToken).toBe(previous);
    history.replaceState({}, '', `/#commons-token=${next}`);
    expect((await chatAuthority(SOCKET, true, '')).personToken).toBe(next);
  });
});
