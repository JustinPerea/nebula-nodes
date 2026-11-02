/**
 * PR #204 round 14, GM r22: the Commons page's load lines, one rule and no ranking between loads
 * (components/commons/useCommonsLine useCommonsLoadLines, pageLoadLines).
 * - A tab that isn't connected as you (never connected, demoted, a stale token): one line for the
 *   page, "Nebula couldn’t load the Commons because this tab isn’t connected as you. …", and no
 *   load's own line ever appears.
 * - A connected tab: one load failing alone shows its own line; every load failing for one reason
 *   shows the page line with that reason; different reasons show one line per failed load, in the
 *   page's order (GM confirmed both).
 * Add's lock line still comes after the page line (its x is the live check's).
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), token: null as string | null }));
vi.mock('../src/lib/backend', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch }));
vi.mock('../src/lib/personSession', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/personSession')>(),
  personToken: async () => transport.token,
}));
vi.mock('../src/components/commons/CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: () => null }));
vi.mock('../src/components/commons/CommonsReview', () => ({ CommonsReview: () => null }));
vi.mock('../src/components/commons/CommonsSettings', () => ({ CommonsSettings: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { pageLoadLines } = await import('../src/components/commons/useCommonsLine');
const { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');

const PAGE = 'Nebula couldn’t load the Commons because this tab isn’t connected as you. Open the link Nebula printed when it started.';
const ADD_LINE = 'You can add references when this tab is connected as you.';
const TOKEN = 'a'.repeat(43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Each load's answer: the library, or a status code that fails it. */
const fails: Record<'status' | 'collections' | 'search', number | null> = { status: null, collections: null, search: null };
function answer(path: string): Response {
  const load = path.endsWith('/status') ? 'status' : path.endsWith('/collections') ? 'collections' : path.endsWith('/search') ? 'search' : null;
  if (load && fails[load] !== null) return json({ detail: 'no' }, fails[load]!);
  if (load === 'status') return json({ worker: { running: false, state: 'idle' }, queue: {} });
  if (load === 'collections') return json([{ id: 'c1', name: 'Refs', kind: 'user' }]);
  if (load === 'search') return json({ results: [] });
  return json({});
}

const shownLines = () => [...document.querySelectorAll('[data-commons-line]')].map((line) => line.textContent ?? '');
/** Every line the page showed while the test ran, not only at the end. */
let seen: string[] = [];
let watcher: MutationObserver | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  resetPersonSessionForTests();
  resetCommonsSessionForTests();
  resetLinesForTests();
  window.sessionStorage.clear();
  fails.status = null; fails.collections = null; fails.search = null;
  transport.token = null;
  transport.fetch.mockReset();
  transport.fetch.mockImplementation(async (path: string) => answer(path));
  seen = [];
  watcher = new MutationObserver(() => { seen.push(...shownLines()); });
  watcher.observe(document.body, { subtree: true, childList: true, characterData: true });
});
afterEach(() => { watcher?.disconnect(); cleanup(); act(() => notePersonPromoted()); vi.useRealTimers(); });

/** Round 15 (CI on d2040a0f): fake time moves only when the test moves it, so a line's arrival
 * doesn't depend on the machine's speed. `until` moves it 50 ms at a time, up to `max` ms. */
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
async function until(check: () => void, max = 3000): Promise<void> {
  for (let waited = 0; ; waited += 50) {
    try { check(); return; } catch (error) { if (waited >= max) throw error; }
    await tick(50);
  }
}

const LOAD_WORDS = /check the Commons status|load the references|search the library|load the collections|library status/;

describe('pageLoadLines (GM r22)', () => {
  const failure = (line: string, page: string, person = false) => ({ line, page, person });
  it('a refusal for this tab: the page line only, whatever else failed', () => {
    expect(pageLoadLines([failure('status because', PAGE, true)])).toEqual([PAGE]);
    expect(pageLoadLines([failure('Couldn’t x. A.', 'Couldn’t load the Commons. A.'), failure('refs because', PAGE, true)])).toEqual([PAGE]);
  });
  it('one load alone: its own line; one reason for several: the page line; different reasons: each, in order', () => {
    expect(pageLoadLines([failure('Couldn’t x. A.', 'P. A.')])).toEqual(['Couldn’t x. A.']);
    expect(pageLoadLines([failure('Couldn’t x. A.', 'P. A.'), failure('Couldn’t y. A.', 'P. A.')])).toEqual(['P. A.']);
    expect(pageLoadLines([failure('Couldn’t x. A.', 'P. A.'), failure('Couldn’t y. B.', 'P. B.')])).toEqual(['Couldn’t x. A.', 'Couldn’t y. B.']);
    expect(pageLoadLines([])).toEqual([]);
  });
});

describe('a tab that isn\'t connected as you: one page line, never a load\'s own (GM r22)', () => {
  const expectPageLineOnly = async () => {
    await until(() => expect(shownLines()).toEqual([PAGE]));
    // The status poll and the loads keep refusing for a while: still the one line.
    await tick(300);
    expect(shownLines()).toEqual([PAGE]);
    expect(seen.filter((text) => LOAD_WORDS.test(text))).toEqual([]);
    // Add's line comes after it, in the same row.
    const row = document.querySelector('[data-page-lines]')!;
    expect([...row.children].map((kid) => kid.textContent)).toEqual([PAGE, ADD_LINE]);
  };

  it('never connected', async () => {
    act(() => reportPersonRequired());
    render(<CommonsView />);
    await expectPageLineOnly();
  });

  it('demoted', async () => {
    transport.token = TOKEN;
    render(<CommonsView />);
    await until(() => expect(transport.fetch).toHaveBeenCalled());
    act(() => { notePersonPromoted(); reportPersonRequired(); });
    await expectPageLineOnly();
  });

  it('a stale token (kept across a reload, the socket refusing it)', async () => {
    window.sessionStorage.setItem('nebula.person', JSON.stringify({ token: 'stale-person-token-0123456789', backend: 'http://127.0.0.1:8000' }));
    transport.token = 'stale-person-token-0123456789';
    act(() => reportPersonRequired());
    // Held past the 150 ms handover, as a reloaded tab is by the time it opens the Commons.
    await tick(200);
    render(<CommonsView />);
    await expectPageLineOnly();
    expect(transport.fetch).not.toHaveBeenCalled();
  });
});

describe('a connected tab (GM r22, confirmed)', () => {
  it('one load failing alone shows its own line', async () => {
    transport.token = TOKEN;
    fails.search = 500;
    render(<CommonsView />);
    await until(() => expect(shownLines()).toHaveLength(1));
    // Round 15 (GM r24 c), verbatim.
    expect(shownLines()[0]).toBe('Nebula couldn’t load the references because it didn’t respond. Try again.');
  });

  it('every load failing for one reason shows the page line with that reason', async () => {
    transport.token = TOKEN;
    fails.status = 500; fails.collections = 500; fails.search = 500;
    render(<CommonsView />);
    await until(() => expect(shownLines()).toHaveLength(1));
    await tick(600);
    expect(shownLines()).toHaveLength(1);
    expect(shownLines()[0]).toBe('Nebula couldn’t load the Commons because it didn’t respond. Try again.');
  });

  it('two different reasons show one line per failed load, in the page\'s order', async () => {
    transport.token = TOKEN;
    fails.status = 500; fails.search = 404;
    // The status answers last, so arrival order isn't the page's order.
    transport.fetch.mockImplementation(async (path: string) => {
      if (path.endsWith('/status')) await new Promise((resolve) => { setTimeout(resolve, 600); });
      return answer(path);
    });
    render(<CommonsView />);
    await until(() => expect(shownLines()).toHaveLength(2));
    const [first, second] = shownLines();
    expect(first).toBe('Nebula couldn’t check the Commons status because it didn’t respond. Try again.');
    // Round 18b (GM r29 1): a load's other reason is a Nebula-subject load line too.
    expect(second).toMatch(/^Nebula couldn’t load the references[. ]/);
    expect(second).not.toMatch(/respond/);
  });
});
