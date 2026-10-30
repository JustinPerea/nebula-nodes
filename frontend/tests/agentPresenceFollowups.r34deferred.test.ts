// PR #200 fix round 23, review 19 LOW-1 (GM r34: approved): a held run
// dismissed while the person gate holds is released on the promote even
// after a reload in between. The ids are kept in this tab's sessionStorage
// (a tab without storage keeps them in memory, as before); only a promote
// sends, each id once; an approval the server no longer has answers
// not_found, which is done.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ releaseApproval: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../src/store/graphStore', () => ({ useGraphStore: { getState: () => ({ nodes: [], isExecuting: false }) },
  watchGraphSyncs: () => ({ seen: new Set<string>(), stop: () => {} }) }));
// The store reads the keys for Accept's and Run's key lock (PR #203 r5); the
// real uiStore reads localStorage unguarded as it loads, so stand it in, as
// the canvas store is.
vi.mock('../src/store/uiStore', () => ({ useUIStore: { getState: () => ({ settingsCache: { apiKeys: {}, loaded: false } }) } }));
vi.mock('../src/lib/canvasProposals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/canvasProposals')>()), releaseApproval: api.releaseApproval }));

type Store = typeof import('../src/store/canvasProposalsStore');
type Session = typeof import('../src/lib/personSession');
const KEY = 'nebula.heldRunReleases';
const loaded: Array<Store> = [];

/** A page load: the store and the session modules fresh, the tab's sessionStorage as it was. */
async function load(): Promise<{ store: Store; session: Session }> {
  for (const before of loaded.splice(0)) before.forgetHeldReleasesForTests();
  vi.resetModules();
  const store = await import('../src/store/canvasProposalsStore');
  const session = await import('../src/lib/personSession');
  loaded.push(store);
  return { store, session };
}

const hold = (store: Store, approvalId: string) => store.useCanvasProposalsStore.setState(
  { deferredRun: { agentName: 'Codex', nodeIds: ['n7'], approvalId }, deferredQueue: [] } as never);
const released = () => api.releaseApproval.mock.calls.map((call) => call[0]);

beforeEach(() => {
  window.sessionStorage.clear();
  api.releaseApproval.mockReset();
  api.releaseApproval.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); window.sessionStorage.clear(); });

describe('review 19 LOW-1: a held Dismiss survives a reload', () => {
  it('dismiss while held, reload, promote: exactly one release; a second promote sends none', async () => {
    const first = await load();
    first.session.reportPersonRequired();
    hold(first.store, 'ra_c');
    first.store.useCanvasProposalsStore.getState().dismissDeferred();
    expect(api.releaseApproval).not.toHaveBeenCalled();
    expect(JSON.parse(window.sessionStorage.getItem(KEY) ?? '[]')).toEqual(['ra_c']);

    const second = await load();
    // Loading sends nothing: only a promote does.
    expect(api.releaseApproval).not.toHaveBeenCalled();
    second.session.reportPersonRequired();
    expect(api.releaseApproval).not.toHaveBeenCalled();
    second.session.notePersonPromoted();
    expect(released()).toEqual(['ra_c']);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    second.session.notePersonPromoted();
    expect(released()).toEqual(['ra_c']);

    // And a third load has nothing left to send.
    const third = await load();
    third.session.notePersonPromoted();
    expect(released()).toEqual(['ra_c']);
  });

  it('a tab whose storage throws behaves as before: held in memory, one release on the promote', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    const { store, session } = await load();
    session.reportPersonRequired();
    hold(store, 'ra_m');
    expect(() => store.useCanvasProposalsStore.getState().dismissDeferred()).not.toThrow();
    expect(api.releaseApproval).not.toHaveBeenCalled();
    session.notePersonPromoted();
    expect(released()).toEqual(['ra_m']);
    session.notePersonPromoted();
    expect(released()).toEqual(['ra_m']);
    // A connected tab still releases at once.
    hold(store, 'ra_n');
    store.useCanvasProposalsStore.getState().dismissDeferred();
    expect(released()).toEqual(['ra_m', 'ra_n']);
  });

  it('an id that expired meanwhile is harmless: one release (the server answers not_found), then it is gone', async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(['ra_gone', 7, '']));
    // The server answers 200 {"status":"not_found"} for an approval it no longer has; the release resolves.
    api.releaseApproval.mockImplementation(async () => ({ status: 'not_found' }));
    const { session } = await load();
    session.notePersonPromoted();
    expect(released()).toEqual(['ra_gone']);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    session.notePersonPromoted();
    expect(released()).toEqual(['ra_gone']);
  });

  it('malformed storage is ignored and nothing is sent for it', async () => {
    window.sessionStorage.setItem(KEY, '{not json');
    const { session } = await load();
    session.notePersonPromoted();
    expect(api.releaseApproval).not.toHaveBeenCalled();
  });
});
