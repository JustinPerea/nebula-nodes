/**
 * PR #204 round 15 (review 12): the token drop reads one answer per hello.
 *
 * A canvas socket can carry two hellos: a person link taken in the tab while the first hello's
 * answer is on its way says hello again on the same open socket. The server answers hellos in
 * order, one answer each (`personRequired` for a refusal, the promote's `proposalSync`). So a
 * refusal names the token of the oldest hello still unanswered, never the newest one.
 * Also pinned here: the Commons drop compares the token the refused call carried (not the tab's
 * current one), and today's restart behaviour (a refusal while the last health answer is offline
 * keeps the token until the next refusal), which waits on Justin's call.
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
  for (const method of ['log', 'warn', 'error', 'debug'] as const) consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => {}));
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


describe('round 15: one answer per hello', () => {
  it('a new link taken while the old hello is answered keeps the new, valid token', async () => {
    const f = await fresh();
    healthSettles(f);
    f.wsClient.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].onopen?.();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    // The person takes the new link in this tab while the old hello's answer is on its way.
    history.replaceState({}, '', `/#nebula-person=${NEW_TOKEN}&backend=${BACKEND}`);
    f.session.browserPersonCredential(); // what the app's one hashchange listener does
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(2));
    expect(sockets[0].sent.map((frame) => JSON.parse(frame).personToken === NEW_TOKEN)).toEqual([false, true]);
    // The server answers in order: the old hello refused, then the new one promoted.
    sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify(REFUSED) }));
    sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'proposalSync', proposals: [] }) }));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(JSON.parse(stored()!).token).toBe(NEW_TOKEN);
    expect(await f.session.personToken()).toBe(NEW_TOKEN);
    expect(f.session.personPromotions()).toBe(1);
    f.wsClient.disconnect();
  });

  it('each answer takes its own hello: a promote then a refusal names the second hello\'s token', async () => {
    // A contract pin on the bookkeeping: the promote consumes the first hello's entry, so the
    // refusal that follows is read against the second hello's token, which the tab holds.
    const f = await fresh();
    healthSettles(f);
    f.wsClient.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].onopen?.();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    history.replaceState({}, '', `/#nebula-person=${NEW_TOKEN}&backend=${BACKEND}`);
    f.session.browserPersonCredential();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(2));
    sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'proposalSync', proposals: [] }) }));
    sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify(REFUSED) }));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(stored()).toBeNull();
    f.wsClient.disconnect();
  });

  it('two hellos, both refused: the second refusal drops the second hello\'s token', async () => {
    const f = await fresh();
    healthSettles(f);
    f.wsClient.connect();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].onopen?.();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(1));
    history.replaceState({}, '', `/#nebula-person=${NEW_TOKEN}&backend=${BACKEND}`);
    f.session.browserPersonCredential();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(2));
    sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify(REFUSED) }));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(JSON.parse(stored()!).token).toBe(NEW_TOKEN); // the first refusal was the old hello's
    sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify(REFUSED) }));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(stored()).toBeNull(); // the second is the new hello's: the backend says it is invalid
    f.wsClient.disconnect();
  });

  it('one hello refused still drops its own token (the plain case)', async () => {
    const f = await fresh();
    healthSettles(f);
    await helloAnswered(f, REFUSED);
    expect(stored()).toBeNull();
    f.wsClient.disconnect();
  });

  it('a refusal with no hello waiting drops nothing', async () => {
    const f = await fresh();
    healthSettles(f);
    await helloAnswered(f, { type: 'proposalSync', proposals: [] });
    sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify(REFUSED) }));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(stored()).toBe(STORED);
    f.wsClient.disconnect();
  });
});

describe('round 15: the Commons drop compares the token the refused call carried', () => {
  it('a Commons 401 for the old token, answered after a new link was taken, keeps the new token', async () => {
    const f = await fresh();
    healthSettles(f);
    let n = 0;
    commonsAnswer = async () => {
      n += 1;
      if (n === 2) { history.replaceState({}, '', `/#nebula-person=${NEW_TOKEN}&backend=${BACKEND}`); f.session.browserPersonCredential(); }
      return json(401);
    };
    await expect(f.commons.commonsApi.status()).rejects.toMatchObject({ status: 401 });
    expect(commonsCalls()).toBe(2);
    expect(JSON.parse(stored()!).token).toBe(NEW_TOKEN);
  });
});

describe('round 15: after a restart (current behaviour, a question for Justin)', () => {
  it('a reconnect refused while the last health answer is offline keeps the old token, even once online returns', async () => {
    const f = await fresh();
    healthSettles(f);
    f.connection.noteProbeAnswer(f.connection.startHealthProbe(), 'offline');
    await helloAnswered(f, REFUSED);
    healthSettles(f);
    // Kept until the next refusal: it never drops while Nebula is starting.
    expect(stored()).toBe(STORED);
    // The next refusal, with online answered, drops it.
    sockets[0].onopen?.();
    await vi.waitFor(() => expect(sockets[0].sent).toHaveLength(2));
    sockets[0].onmessage?.(new MessageEvent('message', { data: JSON.stringify(REFUSED) }));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(stored()).toBeNull();
    f.wsClient.disconnect();
  });
});
