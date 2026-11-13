// PR #199 fix round 23, lane B, item 1 (review 21 reopen-tabs LOW-1): a live
// page never changes its tab id. It lets go of its Web Lock at pagehide, so a
// reload's new page finds it free at once; the claim never waits
// (`ifAvailable`), so a page whose id another live page holds makes a new one
// at once; and nothing that names the tab (apiFetch's X-Nebula-Tab, the
// socket's hello and kept frame) goes before the claim settles. A page back
// from the back/forward cache whose id a copy took moves once, before it
// sends anything, and the open socket says its kept state again under it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTabIdentity, type LockManagerLike, type TabIdentity } from '../src/lib/tabId';

/** A lock manager shared by every page of the browser, as navigator.locks is.
 * `ifAvailable` answers null at once when the lock is held; a held lock goes
 * when its callback's promise settles. `deferGrants` holds every answer until
 * `grantAll()`, to see what a page does before its claim settles. */
function fakeLocks(options: { deferGrants?: boolean } = {}) {
  const held = new Set<string>();
  const waiting: Array<() => void> = [];
  const requests: string[] = [];
  const locks: LockManagerLike & { held: Set<string>; requests: string[]; grantAll: () => void } = {
    held,
    requests,
    grantAll: () => { for (const go of waiting.splice(0)) go(); },
    request: (name, opts, callback) => {
      requests.push(`${name}${opts.ifAvailable ? ' ifAvailable' : ''}`);
      const run = () => {
        if (held.has(name)) return Promise.resolve(callback(null));
        held.add(name);
        return Promise.resolve(callback({ name })).finally(() => held.delete(name));
      };
      if (!options.deferGrants) return Promise.resolve().then(run);
      return new Promise((resolve) => { waiting.push(() => { void run().then(resolve); }); });
    },
  };
  return locks;
}

/** sessionStorage for one browser tab; `copyOf` is what a duplicated tab gets. */
function tabStorage(copyOf?: Storage): Storage {
  const values = new Map<string, string>();
  if (copyOf) for (let i = 0; i < copyOf.length; i += 1) values.set(copyOf.key(i)!, copyOf.getItem(copyOf.key(i)!)!);
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every id a page could have sent: the id at each moment it was confirmed. */
function watch(page: TabIdentity) {
  const sent: string[] = [];
  const rekeys: Array<{ next: string; previous: string; confirmedThen: boolean }> = [];
  page.onRekey((next, previous) => rekeys.push({ next, previous, confirmedThen: page.confirmed }));
  const sample = () => { if (page.confirmed && sent.at(-1) !== page.id) sent.push(page.id); };
  return { sent, rekeys, sample };
}

describe('review 21 LOW-1: leave, copy, come back', () => {
  it('the copy loads first, then the first page comes back from the back/forward cache: no shared id, and only the restored page moves, once, before it sends', async () => {
    const locks = fakeLocks();
    const storageA = tabStorage();
    const a = createTabIdentity(storageA, locks);
    const watchA = watch(a);
    const first = await a.ready();
    watchA.sample();
    // A leaves Nebula in its tab: it lets go of its lock and marks its id free.
    a.pageHide();
    expect(a.confirmed).toBe(false);
    await settle();
    expect(locks.held.has(`nebula-tab:${first}`)).toBe(false);
    // A copy of the tab is made from the page A went to: it takes the free id.
    const c = createTabIdentity(tabStorage(storageA), locks);
    const watchC = watch(c);
    expect(c.id).toBe(first);
    expect(await c.ready()).toBe(first);
    watchC.sample();
    // A comes back from the back/forward cache: its id is C's now.
    const back = a.pageShow(true);
    expect(a.confirmed).toBe(false);
    const moved = await back;
    watchA.sample();
    watchC.sample();
    expect(moved).not.toBe(first);
    expect(a.id).toBe(moved);
    expect(c.id).toBe(first);
    expect(storageA.getItem('nebula:tabId')).toBe(moved);
    expect(locks.held.has(`nebula-tab:${moved}`)).toBe(true);
    expect(locks.held.has(`nebula-tab:${first}`)).toBe(true);
    // One move, made while A held no id (so before anything sent it).
    expect(watchA.rekeys).toEqual([{ next: moved, previous: first, confirmedThen: false }]);
    expect(watchC.rekeys).toEqual([]);
    // Neither page sent an id the other holds; C's never changed.
    expect(watchC.sent).toEqual([first]);
    expect(watchA.sent).toEqual([first, moved]);
    expect(a.id).not.toBe(c.id);
  });

  it('the first page comes back first, then the copy loads: the first keeps its id, the copy makes its own before it sends', async () => {
    const locks = fakeLocks();
    const storageA = tabStorage();
    const a = createTabIdentity(storageA, locks);
    const watchA = watch(a);
    const first = await a.ready();
    watchA.sample();
    a.pageHide();
    const storageC = tabStorage(storageA);
    expect(await a.pageShow(true)).toBe(first);
    watchA.sample();
    const c = createTabIdentity(storageC, locks);
    const watchC = watch(c);
    watchC.sample();
    expect(c.confirmed).toBe(false);
    const own = await c.ready();
    watchC.sample();
    expect(own).not.toBe(first);
    expect(storageC.getItem('nebula:tabId')).toBe(own);
    expect(watchA.sent).toEqual([first]);
    expect(watchA.rekeys).toEqual([]);
    expect(watchC.sent).toEqual([own]);
    expect(watchC.rekeys).toEqual([{ next: own, previous: first, confirmedThen: false }]);
  });

  it('the first page comes back as a new load (no back/forward cache) after the copy: the new load makes its own id before it sends', async () => {
    const locks = fakeLocks();
    const storageA = tabStorage();
    const a = createTabIdentity(storageA, locks);
    const first = await a.ready();
    a.pageHide();
    const c = createTabIdentity(tabStorage(storageA), locks);
    expect(await c.ready()).toBe(first);
    const again = createTabIdentity(storageA, locks);
    const own = await again.ready();
    expect(own).not.toBe(first);
    expect(c.id).toBe(first);
  });

  it('a copy made while the first page is open makes its own id at once, with no wait', async () => {
    vi.useFakeTimers();
    try {
      const locks = fakeLocks();
      const storageA = tabStorage();
      const a = createTabIdentity(storageA, locks);
      await vi.waitFor(() => expect(a.confirmed).toBe(true));
      // The contrived copy that shares the free mark (review 20 LOW-4).
      storageA.setItem('nebula:tabIdFree', a.id);
      const c = createTabIdentity(tabStorage(storageA), locks);
      // Only microtasks: no timer is advanced.
      for (let i = 0; i < 10 && !c.confirmed; i += 1) await Promise.resolve();
      expect(c.confirmed).toBe(true);
      expect(c.id).not.toBe(a.id);
      expect(locks.requests.every((request) => request.endsWith(' ifAvailable'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a reload keeps its id with no wait: the old page let go at pagehide', async () => {
    vi.useFakeTimers();
    try {
      const locks = fakeLocks();
      const storage = tabStorage();
      const before = createTabIdentity(storage, locks);
      await vi.waitFor(() => expect(before.confirmed).toBe(true));
      const id = before.id;
      before.pageHide();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      const reload = createTabIdentity(storage, locks);
      for (let i = 0; i < 10 && !reload.confirmed; i += 1) await Promise.resolve();
      expect(reload.confirmed).toBe(true);
      expect(reload.id).toBe(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a page that went while its claim was on its way doesn’t keep the lock', async () => {
    const locks = fakeLocks({ deferGrants: true });
    const page = createTabIdentity(tabStorage(), locks);
    page.pageHide();
    locks.grantAll();
    await settle();
    expect(locks.held.size).toBe(0);
    expect(page.confirmed).toBe(false);
  });

  // Mutant T1 of review 21, re-derived: a claim that settles after the page
  // went (or claimed again) changes nothing. Each answer of the lock manager
  // can come after a pagehide.
  it('a page that went while its claim was on its way and refused doesn’t move to a new id', async () => {
    const locks = fakeLocks({ deferGrants: true });
    const storage = tabStorage();
    storage.setItem('nebula:tabId', 'tab-copied');
    storage.setItem('nebula:tabIdFree', 'tab-copied');
    locks.held.add('nebula-tab:tab-copied');
    const page = createTabIdentity(storage, locks);
    const rekeys = watch(page).rekeys;
    page.pageHide();
    locks.grantAll();
    await settle();
    locks.grantAll();
    await settle();
    expect(rekeys).toEqual([]);
    expect(page.id).toBe('tab-copied');
    expect(page.confirmed).toBe(false);
    expect([...locks.held]).toEqual(['nebula-tab:tab-copied']);
  });

  it('a page that went while its new id’s claim was on its way doesn’t confirm it or keep its lock', async () => {
    const locks = fakeLocks({ deferGrants: true });
    const storage = tabStorage();
    storage.setItem('nebula:tabId', 'tab-copied');
    storage.setItem('nebula:tabIdFree', 'tab-copied');
    locks.held.add('nebula-tab:tab-copied');
    const page = createTabIdentity(storage, locks);
    locks.grantAll();
    await settle();
    // Refused: it moved to a new id, whose claim is on its way now.
    expect(page.id).not.toBe('tab-copied');
    expect(page.confirmed).toBe(false);
    page.pageHide();
    locks.grantAll();
    await settle();
    expect(page.confirmed).toBe(false);
    expect([...locks.held]).toEqual(['nebula-tab:tab-copied']);
  });

  it('a page shown again while its first claim was on its way: only the newer claim confirms it', async () => {
    const locks = fakeLocks({ deferGrants: true });
    const page = createTabIdentity(tabStorage(), locks);
    page.pageHide();
    const shown = page.pageShow(true);
    locks.grantAll();
    await settle();
    locks.grantAll();
    expect(await shown).toBe(page.id);
    expect(page.confirmed).toBe(true);
    // One lock, the newer claim's: the older one let go at once.
    expect([...locks.held]).toEqual([`nebula-tab:${page.id}`]);
  });

  // Item 6 of the lane: a reload whose old page's release hasn't reached the
  // lock manager yet finds its id taken, so it makes a fresh one at once
  // rather than wait. Safe (two live pages never share an id), but the tab
  // then goes by a new id for its tab-local nodes.
  it('a reload whose old page’s release hasn’t landed yet makes a fresh id, held before anything sends it', async () => {
    const locks = fakeLocks();
    const storage = tabStorage();
    const before = createTabIdentity(storage, locks);
    const id = await before.ready();
    // The old page went (its free mark is set) but its lock is still held.
    storage.setItem('nebula:tabIdFree', id);
    const reload = createTabIdentity(storage, locks);
    const watchReload = watch(reload);
    watchReload.sample();
    const own = await reload.ready();
    watchReload.sample();
    expect(own).not.toBe(id);
    expect(watchReload.sent).toEqual([own]);
    expect(storage.getItem('nebula:tabId')).toBe(own);
  });

  it('no Web Locks: the free mark alone, as before (confirmed at once; pagehide and pageshow keep the id)', async () => {
    const storage = tabStorage();
    const page = createTabIdentity(storage, null);
    expect(page.confirmed).toBe(true);
    const id = page.id;
    page.pageHide();
    expect(page.confirmed).toBe(true);
    expect(storage.getItem('nebula:tabIdFree')).toBe(id);
    expect(await page.pageShow(true)).toBe(id);
    expect(storage.getItem('nebula:tabIdFree')).toBeNull();
    // The reload in the same tab takes it by the free mark.
    page.pageHide();
    expect(createTabIdentity(storage, null).id).toBe(id);
  });

  it('locks that throw count as none', async () => {
    const page = createTabIdentity(tabStorage(), { request: () => { throw new Error('SecurityError'); } });
    expect(await page.ready()).toBe(page.id);
  });
});

// The module's own page: apiFetch and the socket wait for its claim.
type Sock = { url: string; sent: string[]; readyState: number; onopen: (() => void) | null };
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

describe('review 21 LOW-1: nothing names the tab before the claim settles', () => {
  const TOKEN = 'browser-person-token-000000000000000000000';
  let locks: ReturnType<typeof fakeLocks>;
  beforeEach(() => {
    sockets = [];
    sessionStorage.clear();
    vi.stubEnv('VITE_NEBULA_BACKEND_PORT', '');
    vi.stubEnv('VITE_NEBULA_BACKEND_PORTS', '');
    vi.resetModules();
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks');
    sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** This tab's sessionStorage names `id` free, and another live page holds its lock. */
  function copiedTabWhoseIdIsHeld(id: string) {
    locks = fakeLocks({ deferGrants: true });
    locks.held.add(`nebula-tab:${id}`);
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    sessionStorage.setItem('nebula:tabId', id);
    sessionStorage.setItem('nebula:tabIdFree', id);
  }

  it('apiFetch’s first write waits for the claim and sends the id the page ends on, never the one another page holds', async () => {
    copiedTabWhoseIdIsHeld('tab-held-by-another-page');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const tabId = await import('../src/lib/tabId');
    const { apiFetch } = await import('../src/lib/backend');
    expect(tabId.tabIdConfirmed()).toBe(false);
    const sending = apiFetch('/api/graph', { method: 'POST', body: '{}' });
    await settle();
    const writes = () => fetchMock.mock.calls.filter(([, init]) => String((init as RequestInit | undefined)?.method ?? 'GET') === 'POST');
    expect(writes()).toHaveLength(0);
    locks.grantAll();
    await settle();
    locks.grantAll();
    await sending;
    expect(writes()).toHaveLength(1);
    const header = new Headers((writes()[0][1] as RequestInit).headers).get('X-Nebula-Tab');
    expect(header).toBe(tabId.TAB_ID);
    expect(header).not.toBe('tab-held-by-another-page');
    expect(tabId.tabIdConfirmed()).toBe(true);
  });

  it('a read doesn’t wait (it names no tab)', async () => {
    copiedTabWhoseIdIsHeld('tab-held-by-another-page');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = await import('../src/lib/backend');
    await apiFetch('/api/graph');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/graph'))).toBe(true);
  });

  it('the socket’s hello waits for the claim; a page that moves says its kept state again under the new id', async () => {
    copiedTabWhoseIdIsHeld('tab-held-by-another-page');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    vi.stubGlobal('WebSocket', MockWS);
    sessionStorage.setItem('nebula.person', JSON.stringify({ token: TOKEN, backend: 'http://localhost:8000' }));
    const tabId = await import('../src/lib/tabId');
    const { wsClient } = await import('../src/lib/wsClient');
    wsClient.setKeptEdits(true);
    wsClient.connect();
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    const socket = sockets.at(-1)!;
    socket.onopen?.();
    await settle();
    expect(socket.sent).toEqual([]);
    locks.grantAll();
    await settle();
    locks.grantAll();
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    const frames = socket.sent.map((raw) => JSON.parse(raw) as { type: string; tab?: string });
    expect(frames[0].type).toBe('hello');
    const kept = frames.filter((frame) => frame.type === 'keptEdits');
    expect(kept.length).toBeGreaterThan(0);
    for (const frame of kept) expect(frame.tab).toBe(tabId.TAB_ID);
    expect(tabId.TAB_ID).not.toBe('tab-held-by-another-page');

    // The page goes into the back/forward cache with the socket open, a copy
    // takes its id, and it comes back: the kept frame goes again, under the
    // new id, once the new id is held.
    const before = tabId.TAB_ID;
    socket.sent.length = 0;
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    locks.held.add(`nebula-tab:${before}`);
    const show = new Event('pageshow');
    Object.defineProperty(show, 'persisted', { value: true });
    window.dispatchEvent(show);
    await settle();
    expect(socket.sent).toEqual([]);
    locks.grantAll();
    await settle();
    // Refused: the page moved to a new id, whose claim is still on its way.
    // Nothing goes under it until it is held.
    expect(tabId.TAB_ID).not.toBe(before);
    expect(tabId.tabIdConfirmed()).toBe(false);
    expect(socket.sent).toEqual([]);
    locks.grantAll();
    await vi.waitFor(() => expect(socket.sent.length).toBe(1));
    expect(JSON.parse(socket.sent[0])).toEqual({ type: 'keptEdits', kept: true, tab: tabId.TAB_ID });

    // A page that keeps no edits says nothing when it moves.
    wsClient.setKeptEdits(false);
    await settle();
    socket.sent.length = 0;
    const second = tabId.TAB_ID;
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    locks.held.add(`nebula-tab:${second}`);
    const again = new Event('pageshow');
    Object.defineProperty(again, 'persisted', { value: true });
    window.dispatchEvent(again);
    for (let i = 0; i < 3; i += 1) { locks.grantAll(); await settle(); }
    await vi.waitFor(() => expect(tabId.tabIdConfirmed()).toBe(true));
    expect(tabId.TAB_ID).not.toBe(second);
    await settle();
    expect(socket.sent).toEqual([]);
    wsClient.disconnect();
  });
});
