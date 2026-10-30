// PR #200 fix round 19, GM r29 item 3: the person hold (and the banner)
// follow the server's state both ways. The server promotes this tab's canvas
// socket on a verified hello and only then sends it the person-only
// `proposalSync` (backend websocket_endpoint); it demotes with `personRequired`
// (a refused hello) or a 403 person_required. A link taken in is not proof.
// Promote by every path: a new link, the same link reopened, an accepted
// reconnect hello, the desktop app's token. And demote.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

const TOKEN = 'browser-person-token-000000000000000000000';
const DESKTOP_TOKEN = 'synthetic-desktop-person-token-0000000000';

type Sock = { url: string; sent: string[]; readyState: number; closed: boolean;
  onopen: (() => void) | null; onmessage: ((event: MessageEvent) => void) | null; onclose: (() => void) | null };
let sockets: Sock[] = [];
class MockWS {
  static OPEN = 1;
  readyState = 1;
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { sockets.push(this as unknown as Sock); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.closed = true; }
}

const frame = (socket: Sock, data: unknown) => act(() => { socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) })); });
const promote = (socket: Sock) => frame(socket, { type: 'proposalSync', proposals: [] });
const hellos = (socket: Sock) => socket.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === 'hello');

async function fresh() {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  vi.stubGlobal('WebSocket', MockWS);
  const session = await import('../../src/lib/personSession');
  const { wsClient } = await import('../../src/lib/wsClient');
  const { PersonRequiredBanner } = await import('../../src/components/PersonRequiredBanner');
  render(<PersonRequiredBanner />);
  return { session, wsClient };
}
/** The canvas socket open, its hello (if any) sent. */
async function open(wsClient: { connect: () => void }) {
  wsClient.connect();
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  const socket = sockets.at(-1)!;
  socket.onopen?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return socket;
}
const bannerUp = () => document.querySelector('.person-required') !== null;

beforeEach(() => {
  sockets = [];
  sessionStorage.clear();
  history.replaceState({}, '', '/');
  vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '');
  vi.stubEnv('VITE_NEBULA_BACKEND_PORTS', '');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  sessionStorage.clear();
  history.replaceState({}, '', '/');
  delete (window as unknown as Record<string, unknown>).nebulaDesktop;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GM r29 item 3: the hold follows the server', () => {
  it('a new link: the hold stays until the server promotes the hello it brings, then it and the banner clear', async () => {
    const { session, wsClient } = await fresh();
    const socket = await open(wsClient);
    act(() => session.reportPersonRequired());
    expect(session.personGateHeld()).toBe(true);
    expect(bannerUp()).toBe(true);
    const origin = new URL(socket.url).origin.replace('ws:', 'http:');
    history.replaceState({}, '', `/#nebula-person=${TOKEN}&backend=${origin}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await vi.waitFor(() => expect(hellos(socket)).toHaveLength(1));
    // Taken in and said hello with, but not promoted yet: still held.
    expect(session.personGateHeld()).toBe(true);
    expect(bannerUp()).toBe(true);
    promote(socket);
    expect(session.personGateHeld()).toBe(false);
    await vi.waitFor(() => expect(bannerUp()).toBe(false));
    wsClient.disconnect();
  });

  it('the same link reopened (the banner\'s own fix) on a promoted socket reconnects, and the new hello\'s promote clears the hold', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    sessionStorage.setItem('nebula.person', JSON.stringify({ token: TOKEN, backend: 'http://localhost:8000' }));
    const { session, wsClient } = await fresh();
    const first = await open(wsClient);
    await vi.waitFor(() => expect(hellos(first)).toHaveLength(1));
    promote(first);
    // Then a person-only request is refused (403 person_required): held.
    act(() => session.reportPersonRequired());
    expect(session.personGateHeld()).toBe(true);
    history.replaceState({}, '', `/#nebula-person=${TOKEN}&backend=http://localhost:8000`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    // The server ignores a second hello on a promoted socket: this one closes and the canvas reconnects.
    await vi.waitFor(() => expect(first.closed).toBe(true));
    act(() => first.onclose?.());
    await act(async () => { vi.advanceTimersByTime(3100); });
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    const second = sockets[1];
    second.onopen?.();
    await vi.waitFor(() => expect(hellos(second)).toEqual([{ type: 'hello', personToken: TOKEN }]));
    expect(session.personGateHeld()).toBe(true);
    promote(second);
    expect(session.personGateHeld()).toBe(false);
    wsClient.disconnect();
  });

  it('an accepted reconnect hello (the backend came back) clears a hold set while it was away', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    sessionStorage.setItem('nebula.person', JSON.stringify({ token: TOKEN, backend: 'http://localhost:8000' }));
    const { session, wsClient } = await fresh();
    const first = await open(wsClient);
    act(() => session.reportPersonRequired());
    act(() => { first.readyState = 3; first.onclose?.(); });
    await act(async () => { vi.advanceTimersByTime(3100); });
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1].onopen?.();
    await vi.waitFor(() => expect(hellos(sockets[1])).toHaveLength(1));
    expect(session.personGateHeld()).toBe(true);
    promote(sockets[1]);
    expect(session.personGateHeld()).toBe(false);
    await vi.waitFor(() => expect(bannerUp()).toBe(false));
    wsClient.disconnect();
  });

  it('the desktop app: its token\'s hello promoted clears the hold (no link event there)', async () => {
    Object.defineProperty(window, 'nebulaDesktop', {
      value: Object.freeze({ apiBaseUrl: 'http://127.0.0.1:56789', wsBaseUrl: 'ws://127.0.0.1:56789',
        person: { token: vi.fn().mockResolvedValue({ ok: true, token: DESKTOP_TOKEN }) } }),
      configurable: true, writable: true,
    });
    const { session, wsClient } = await fresh();
    act(() => session.reportPersonRequired());
    const socket = await open(wsClient);
    await vi.waitFor(() => expect(hellos(socket)).toEqual([{ type: 'hello', personToken: DESKTOP_TOKEN }]));
    expect(session.personGateHeld()).toBe(true);
    promote(socket);
    expect(session.personGateHeld()).toBe(false);
    await vi.waitFor(() => expect(bannerUp()).toBe(false));
    wsClient.disconnect();
  });

  it('demoted: a refused hello brings the hold and the banner back, until the server promotes again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    sessionStorage.setItem('nebula.person', JSON.stringify({ token: TOKEN, backend: 'http://localhost:8000' }));
    const { session, wsClient } = await fresh();
    act(() => session.reportPersonRequired());
    const first = await open(wsClient);
    promote(first);
    expect(session.personGateHeld()).toBe(false);
    await vi.waitFor(() => expect(bannerUp()).toBe(false));
    // The backend restarted with a new token: the reconnect's hello is refused.
    act(() => { first.readyState = 3; first.onclose?.(); });
    await act(async () => { vi.advanceTimersByTime(3100); });
    await vi.waitFor(() => expect(sockets.length).toBe(2));
    sockets[1].onopen?.();
    await vi.waitFor(() => expect(hellos(sockets[1])).toHaveLength(1));
    frame(sockets[1], { type: 'personRequired', message: 'x' });
    expect(session.personGateHeld()).toBe(true);
    await vi.waitFor(() => expect(bannerUp()).toBe(true));
    // A link taken in alone (not yet promoted) doesn't clear it; the server's promote does.
    act(() => { window.dispatchEvent(new CustomEvent(session.PERSON_CONNECTED_EVENT)); });
    expect(session.personGateHeld()).toBe(true);
    promote(sockets[1]);
    expect(session.personGateHeld()).toBe(false);
    wsClient.disconnect();
  });
});
