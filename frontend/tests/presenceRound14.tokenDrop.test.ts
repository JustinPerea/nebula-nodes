/**
 * PR #204 round 14, Justin's decision (2026-10-31): a browser tab drops its stored person token
 * when the backend answers explicitly that the token is invalid, and then reads as a plain
 * never-connected tab; opening the link again connects it. The explicit answers: the canvas
 * socket refusing the hello that carried the token (`personRequired`), and a Commons call refused
 * with 401 after the token was looked up again. Never on a network error, a timeout, a 5xx, any
 * other answer, or while Nebula is starting (a refusal before the first health answer waits for it). The token is a
 * credential: never logged and never in an event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = 'browser-person-token-000000000000000000000';
const NEW_TOKEN = 'browser-person-token-111111111111111111111';
const BACKEND = 'http://127.0.0.1:8131';
const STORED = JSON.stringify({ token: TOKEN, backend: BACKEND });

interface Sock {
  url: string; sent: string[]; readyState: number;
  onopen: (() => void) | null; onmessage: ((event: MessageEvent) => void) | null;
  onclose: (() => void) | null; onerror: (() => void) | null;
}
let sockets: Sock[] = [];
let fetchSpy: ReturnType<typeof vi.fn>;
let commonsAnswer: () => Promise<Response>;
const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
const events: Event[] = [];

async function fresh() {
  vi.resetModules();
  sockets = [];
  class MockWS {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) { sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; }
  }
  vi.stubGlobal('WebSocket', MockWS);
  fetchSpy = vi.fn(async (url: string) => (String(url).includes('/api/commons') ? commonsAnswer()
    : new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('fetch', fetchSpy);
  const connection = await import('../src/lib/backendConnection');
  const session = await import('../src/lib/personSession');
  const { wsClient } = await import('../src/lib/wsClient');
  const commons = await import('../src/lib/commonsApi');
  return { connection, session, wsClient, commons };
}
type Fresh = Awaited<ReturnType<typeof fresh>>;

const healthSettles = ({ connection }: Fresh) => connection.noteProbeAnswer(connection.startHealthProbe(), 'online');
const stored = () => window.sessionStorage.getItem('nebula.person');
const commonsCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/commons')).length;

/** Open the canvas socket, let it say hello with the stored token, and answer `reply`. */
async function helloAnswered({ wsClient }: Fresh, reply: Record<string, unknown> | 'close' | 'error') {
  wsClient.connect();
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0].onopen?.();
  await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
  expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: 'hello', personToken: TOKEN });
  if (reply === 'close') sockets[0].onclose?.();
  else if (reply === 'error') sockets[0].onerror?.();
  else sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify(reply) }));
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}
const REFUSED = { type: 'personRequired', message: 'This tab isn’t connected as you, so it can’t accept or reject proposals.' };
const json = (status: number, detail = status === 401 ? 'invalid UI session token' : 'x') =>
  new Response(JSON.stringify({ detail }), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  window.sessionStorage.clear();
  window.sessionStorage.setItem('nebula.person', STORED);
  history.replaceState({}, '', '/');
  commonsAnswer = async () => json(200);
  events.length = 0;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => {}));
  const dispatch = window.dispatchEvent.bind(window);
  consoleSpies.push(vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event) => { events.push(event); return dispatch(event); }));
});
afterEach(() => {
  // Never logged, never in an event (Justin: the token is a credential).
  for (const spy of consoleSpies) {
    for (const call of spy.mock.calls) expect(JSON.stringify(call, (_k, v) => (v instanceof Event ? v.type : v))).not.toContain(TOKEN);
  }
  for (const event of events) expect(JSON.stringify((event as CustomEvent).detail ?? null)).not.toContain(TOKEN);
  consoleSpies.splice(0).forEach((spy) => spy.mockRestore());
  window.sessionStorage.clear();
  history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('the socket refusing the hello drops the token (Justin, 2026-10-31)', () => {
  it('drops it once health has settled; the tab then reads as never connected and sends no person-only call', async () => {
    const f = await fresh();
    healthSettles(f);
    await helloAnswered(f, REFUSED);
    expect(stored()).toBeNull();
    expect(await f.session.personToken()).toBeNull();
    expect(f.session.holdsPersonCredential()).toBe(false);
    // A Commons read now has no token to send: refused here, nothing sent.
    await expect(f.commons.commonsApi.status()).rejects.toMatchObject({ status: 401 });
    expect(commonsCalls()).toBe(0);
    // The next socket says no hello at all.
    f.wsClient.disconnect();
    f.wsClient.connect();
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(1));
    sockets.at(-1)!.onopen?.();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(sockets.at(-1)!.sent).toEqual([]);
    f.wsClient.disconnect();
  });

  it('opening the link again stores the new token and says hello with it', async () => {
    const f = await fresh();
    healthSettles(f);
    await helloAnswered(f, REFUSED);
    expect(stored()).toBeNull();
    history.replaceState({}, '', `/#nebula-person=${NEW_TOKEN}&backend=${BACKEND}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await vi.waitFor(() => expect(JSON.parse(stored()!)).toEqual({ token: NEW_TOKEN, backend: BACKEND }));
    expect(await f.session.personToken()).toBe(NEW_TOKEN);
    f.wsClient.disconnect();
    f.wsClient.connect();
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(1));
    sockets.at(-1)!.onopen?.();
    await vi.waitFor(() => expect(sockets.at(-1)!.sent).toHaveLength(1));
    expect(JSON.parse(sockets.at(-1)!.sent[0])).toEqual({ type: 'hello', personToken: NEW_TOKEN });
    f.wsClient.disconnect();
  });

  it.each([
    ['Nebula is starting: no health answer yet', (): void => {}],
    ['health answered offline', (f: Fresh) => f.connection.noteProbeAnswer(f.connection.startHealthProbe(), 'offline')],
  ])('keeps it while %s', async (_name, health) => {
    const f = await fresh();
    health(f);
    await helloAnswered(f, REFUSED);
    expect(stored()).toBe(STORED);
    f.wsClient.disconnect();
  });

  it.each([
    ['the socket closes (a network error or a restart)', 'close' as const],
    ['the socket errors', 'error' as const],
    ['any other answer', { type: 'error', message: 'x' }],
    ['a graph sync', { type: 'graphSync', nodes: [], edges: [] }],
  ])('keeps it when %s', async (_name, reply) => {
    const f = await fresh();
    healthSettles(f);
    await helloAnswered(f, reply);
    expect(stored()).toBe(STORED);
    f.wsClient.disconnect();
  });

  it('keeps a token that isn\'t the one the refused hello carried (a new link came meanwhile)', async () => {
    const f = await fresh();
    healthSettles(f);
    f.wsClient.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].onopen?.();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    history.replaceState({}, '', `/#nebula-person=${NEW_TOKEN}&backend=${BACKEND}`);
    f.session.browserPersonCredential();
    sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify(REFUSED) }));
    expect(JSON.parse(stored()!).token).toBe(NEW_TOKEN);
    f.wsClient.disconnect();
  });
});

describe('a Commons call refused with 401 drops the token; nothing else does', () => {
  it('drops it on 401, twice (after the token was looked up again), once health has settled', async () => {
    const f = await fresh();
    healthSettles(f);
    commonsAnswer = async () => json(401);
    await expect(f.commons.commonsApi.status()).rejects.toMatchObject({ status: 401 });
    expect(commonsCalls()).toBe(2);
    expect(stored()).toBeNull();
  });

  it.each([
    ['no UI session: open Nebula from the desktop app or use the dev link'],
    ['invalid or expired agent token'],
    ['x'],
  ])('keeps it on a 401 whose answer isn\'t the invalid-token one (%s)', async (detail) => {
    const f = await fresh();
    healthSettles(f);
    commonsAnswer = async () => json(401, detail);
    await expect(f.commons.commonsApi.status()).rejects.toMatchObject({ status: 401 });
    expect(stored()).toBe(STORED);
  });

  it('the invalid-token answer is the one the backend writes', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const actors = readFileSync(join(__dirname, '../../backend/commons/actors.py'), 'utf8');
    const { INVALID_PERSON_TOKEN_DETAIL } = await import('../src/lib/commonsApi');
    expect(actors).toContain(`raise AuthError("${INVALID_PERSON_TOKEN_DETAIL}")`);
  });

  it('keeps it on 401 while Nebula is starting', async () => {
    const f = await fresh();
    commonsAnswer = async () => json(401);
    await expect(f.commons.commonsApi.status()).rejects.toMatchObject({ status: 401 });
    expect(stored()).toBe(STORED);
  });

  it.each([500, 502, 503, 403, 404, 408])('keeps it on %i', async (status) => {
    const f = await fresh();
    healthSettles(f);
    commonsAnswer = async () => json(status);
    await expect(f.commons.commonsApi.status()).rejects.toBeTruthy();
    expect(stored()).toBe(STORED);
  });

  it('keeps it on a network error or a timeout', async () => {
    const f = await fresh();
    healthSettles(f);
    commonsAnswer = async () => { throw new TypeError('Failed to fetch'); };
    await expect(f.commons.commonsApi.status()).rejects.toBeTruthy();
    expect(stored()).toBe(STORED);
    commonsAnswer = async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); };
    await expect(f.commons.commonsApi.status()).rejects.toBeTruthy();
    expect(stored()).toBe(STORED);
  });
});

describe('the drop guard itself', () => {
  it('drops only the token the refused call carried, in a browser tab, once health answered online', async () => {
    const f = await fresh();
    healthSettles(f);
    f.session.dropRefusedPersonToken(null);
    f.session.dropRefusedPersonToken(NEW_TOKEN);
    expect(stored()).toBe(STORED);
    f.session.dropRefusedPersonToken(TOKEN);
    expect(stored()).toBeNull();
  });

  it('never drops anything in the desktop app (its token comes from the app, not the tab)', async () => {
    const f = await fresh();
    healthSettles(f);
    vi.stubGlobal('nebulaDesktop', { apiBaseUrl: 'http://127.0.0.1:56789', person: { token: async () => ({}) } });
    f.session.dropRefusedPersonToken(TOKEN);
    expect(stored()).toBe(STORED);
  });
});

describe('a refusal before the first health answer waits for it (a fresh tab says hello at once)', () => {
  it('drops the token once health answers online', async () => {
    const f = await fresh();
    await helloAnswered(f, REFUSED);
    expect(stored()).toBe(STORED);
    healthSettles(f);
    expect(stored()).toBeNull();
    f.wsClient.disconnect();
  });

  it('keeps it when health answers offline first', async () => {
    const f = await fresh();
    await helloAnswered(f, REFUSED);
    f.connection.noteProbeAnswer(f.connection.startHealthProbe(), 'offline');
    healthSettles(f);
    expect(stored()).toBe(STORED);
    f.wsClient.disconnect();
  });

  it('keeps it when a promote comes before the health answer', async () => {
    const f = await fresh();
    await helloAnswered(f, REFUSED);
    f.session.notePersonPromoted();
    healthSettles(f);
    expect(stored()).toBe(STORED);
    f.wsClient.disconnect();
  });

  it('keeps a newer token a link stored before the health answer', async () => {
    const f = await fresh();
    await helloAnswered(f, REFUSED);
    history.replaceState({}, '', `/#nebula-person=${NEW_TOKEN}&backend=${BACKEND}`);
    f.session.browserPersonCredential();
    healthSettles(f);
    expect(JSON.parse(stored()!).token).toBe(NEW_TOKEN);
    f.wsClient.disconnect();
  });

  it('a Commons 401 before the health answer drops it once health answers online', async () => {
    const f = await fresh();
    commonsAnswer = async () => json(401);
    await expect(f.commons.commonsApi.status()).rejects.toMatchObject({ status: 401 });
    expect(stored()).toBe(STORED);
    healthSettles(f);
    expect(stored()).toBeNull();
  });
});
