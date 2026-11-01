/**
 * PR #204 round 16 (GM r26): a search can't succeed while the page says why this tab can't load,
 * so "Searching…" clears in the same frame (the same commit) as the page's because line. Every
 * commit of the line row and the results area is recorded; none shows both. Deterministic: fake
 * time, and the page's loads answer only when the test lets them (section 0's harness).
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), token: null as string | null, created: [] as string[] }));
vi.mock('../src/lib/backend', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch }));
vi.mock('../src/lib/personSession', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/personSession')>(),
  personToken: async () => transport.token,
}));
/**
 * Round 15 (CI on d2040a0f): the test says when the page's loads answer, so the one-shift test
 * reads the same on any machine. While `gate.hold` is set, the view's three loads wait for it
 * before they go to the real API (which still answers a held tab unsent).
 */
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null }));
vi.mock('../src/lib/commonsApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/commonsApi')>();
  const waits = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    if (gate.hold) await gate.hold;
    return fn(...args);
  };
  return {
    ...real,
    commonsApi: {
      ...real.commonsApi,
      status: waits(real.commonsApi.status),
      collections: waits(real.commonsApi.collections),
      search: waits(real.commonsApi.search),
    },
  };
});
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: () => null }));
vi.mock('../src/components/commons/CommonsReview', () => ({ CommonsReview: () => null }));
vi.mock('../src/components/commons/CommonsSettings', () => ({ CommonsSettings: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');
const { resetBackendConnectionForTests } = await import('../src/lib/backendConnection');

const PAGE = 'Nebula couldn’t load the Commons because this tab isn’t connected as you. Open the link Nebula printed when it started.';
const ADD_LINE = 'You can add references when this tab is connected as you.';
const TOKEN = 'a'.repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function answer(path: string, init?: RequestInit): Response {
  if (path.endsWith('/status')) return json({ worker: { running: false, state: 'idle' }, queue: {} });
  if (path.endsWith('/collections') && String(init?.method ?? 'GET').toUpperCase() === 'POST') {
    transport.created.push(String(init?.body ?? ''));
    return json({ id: 'c2', name: 'Warm serifs', kind: 'user' });
  }
  if (path.endsWith('/collections')) return json([{ id: 'c1', name: 'Refs', kind: 'user' }]);
  if (path.endsWith('/search')) return json({ results: [] });
  return json({});
}

const row = () => document.querySelector('[data-page-lines]');
const rowTexts = () => [...(row()?.children ?? [])].map((kid) => kid.textContent ?? '');
const SEARCHING = 'Searching…';
const searchingShown = () => [...document.querySelectorAll('.commons-empty')].some((el) => el.textContent === SEARCHING);
/** Every state of the row while the test ran, each commit. */
let frames: string[][] = [];
let watcher: MutationObserver | null = null;

beforeEach(() => {
  vi.useRealTimers();
  resetPersonSessionForTests();
  resetCommonsSessionForTests();
  resetLinesForTests();
  resetBackendConnectionForTests();
  window.sessionStorage.clear();
  transport.token = null;
  transport.created = [];
  transport.fetch.mockReset();
  transport.fetch.mockImplementation(async (path: string, init?: RequestInit) => answer(path, init));
  frames = [];
  watcher = new MutationObserver(() => { frames.push([...rowTexts(), ...(searchingShown() ? [SEARCHING] : [])]); });
  watcher.observe(document.body, { subtree: true, childList: true, characterData: true });
});
afterEach(() => {
  watcher?.disconnect();
  cleanup();
  act(() => notePersonPromoted());
  act(() => resetBackendConnectionForTests());
  vi.useRealTimers();
});

/** Round 15 (CI on d2040a0f): fake time moves only when the test moves it, so a line's arrival
 * doesn't depend on the machine's speed. `until` moves it 50 ms at a time, up to `max` ms. */
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** The real Commons under a loaded machine: well past the default 5 s. */
const VIEW_TIMEOUT = 20_000;

describe('GM r26: “Searching…” goes with the because line', () => {
  let release: () => void = () => {};
  afterEach(() => { gate.hold = null; release(); });

  it('a demote: Searching… goes in the commit the page line lands, while the search still waits for its debounce', async () => {
    vi.useFakeTimers();
    transport.token = TOKEN;
    act(() => notePersonPromoted());
    render(<CommonsView />);
    await tick(1000);
    expect(searchingShown()).toBe(false); // the first search answered
    frames = [];
    act(() => reportPersonRequired());
    // As live: the status and collections reads are refused at once (the tab is held), and the
    // page line lands while the search is still in its 250 ms debounce. 10 ms at a time.
    for (let waited = 0; waited < 3000; waited += 10) await tick(10);
    expect(rowTexts()).toEqual([PAGE, ADD_LINE]);
    expect(searchingShown()).toBe(false);
    const landed = frames.findIndex((frame) => frame.includes(PAGE));
    expect(landed).toBeGreaterThan(0);
    // The new view showed Searching… before the line (the case GM saw)…
    expect(frames.slice(0, landed).some((frame) => frame.includes(SEARCHING))).toBe(true);
    // …and no commit shows the because line with it.
    expect(frames.filter((frame) => frame.includes(PAGE) && frame.includes(SEARCHING))).toEqual([]);
  }, VIEW_TIMEOUT);

  it('a connected tab still shows Searching… while its search is out', async () => {
    vi.useFakeTimers();
    transport.token = TOKEN;
    act(() => notePersonPromoted());
    gate.hold = new Promise<void>((resolve) => { release = resolve; });
    render(<CommonsView />);
    await tick(600);
    expect(searchingShown()).toBe(true);
    expect(rowTexts()).toEqual([]);
    gate.hold = null;
    release();
    await tick(0);
    expect(searchingShown()).toBe(false);
  }, VIEW_TIMEOUT);
});
