// PR #203 round 15: the backend sends `settingsChanged` only to a socket it
// has promoted (a verified hello), so a key change made between a tab's
// connect and its promote reached nothing in that tab, which kept showing the
// old key state until a reload. The promote now reads the settings again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Sock = { url: string; sent: string[]; readyState: number;
  onopen: (() => void) | null; onmessage: ((event: MessageEvent) => void) | null; onclose: (() => void) | null };
let sockets: Sock[] = [];
class MockWS {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { sockets.push(this as unknown as Sock); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

const frame = (socket: Sock, data: unknown) => socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));

async function fresh() {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  vi.stubGlobal('WebSocket', MockWS);
  const { wsClient } = await import('../../src/lib/wsClient');
  const { SETTINGS_SAVED_EVENT } = await import('../../src/store/settingsChangedSocket');
  const heard: unknown[] = [];
  const listener = (event: Event) => heard.push((event as CustomEvent).detail);
  window.addEventListener(SETTINGS_SAVED_EVENT, listener);
  wsClient.connect();
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  const socket = sockets.at(-1)!;
  socket.onopen?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { heard, socket, stop: () => window.removeEventListener(SETTINGS_SAVED_EVENT, listener) };
}

beforeEach(() => {
  sockets = [];
  vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '');
  vi.stubEnv('VITE_NEBULA_BACKEND_PORTS', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('a promote reads the settings again', () => {
  it('the first connect: nothing on open, one read when the server promotes the hello', async () => {
    const { heard, socket, stop } = await fresh();
    expect(heard).toEqual([]);
    frame(socket, { type: 'proposalSync', proposals: [] });
    expect(heard).toEqual([{ source: 'reconnect' }]);
    stop();
  });

  it('a socket that is no longer the open one reads nothing on its late proposalSync', async () => {
    const { heard, socket, stop } = await fresh();
    socket.onclose?.();
    // The client has moved on: the old socket's frame is not a promote of this tab.
    const late = socket;
    (await import('../../src/lib/wsClient')).wsClient.disconnect();
    frame(late, { type: 'proposalSync', proposals: [] });
    expect(heard).toEqual([]);
    stop();
  });

  it('other frames read nothing', async () => {
    const { heard, socket, stop } = await fresh();
    frame(socket, { type: 'graphComplete', duration: 1, nodesExecuted: 1 });
    frame(socket, { type: 'personRequired', message: 'x' });
    expect(heard).toEqual([]);
    stop();
  });
});
