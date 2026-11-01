/**
 * PR #204 round 15, GM r24 b: a list's empty state says it was read and held nothing, so it shows
 * only when its read answered. A failed load shows its failure line and nothing else in that list;
 * a real search with no results keeps "No matches. Drop images or videos here, or use Add."; a
 * tab that isn't connected as you shows neither (the page line says why).
 * The lists: the references grid (All and Inbox), the Add to menu's "No collections", and
 * Settings' linked folders and vocabulary candidates.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { CommonsSettings } = await import('../src/components/commons/CommonsSettings');
const { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');
const { noteBackendConnection, resetBackendConnectionForTests } = await import('../src/lib/backendConnection');

const NO_MATCHES = 'No matches. Drop images or videos here, or use Add.';
const INBOX_EMPTY = 'Nothing waiting in the inbox. Items agents add land here for you to accept.';
const NO_FOLDERS = 'No folders linked. Linked folders are read, never written.';
const NO_TERMS = 'No new terms proposed yet.';
const TOKEN = 'a'.repeat(43);
type Load = 'status' | 'collections' | 'search' | 'folders' | 'settings' | 'candidates';
const fails: Partial<Record<Load, number>> = {};
/** A load the test holds until it lets it answer. */
const held: Partial<Record<Load, Promise<void>>> = {};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function answer(path: string): Promise<Response> {
  const load = (['status', 'collections', 'search', 'folders', 'settings', 'candidates'] as const).find((name) => path.endsWith(`/${name}`));
  if (load && held[load]) await held[load];
  if (load && fails[load]) return json({ detail: 'no' }, fails[load]);
  if (load === 'status') return json({ worker: { running: false, state: 'idle' }, queue: {} });
  if (load === 'collections') return json([]);
  if (load === 'search') return json({ results: [] });
  if (load === 'folders' || load === 'candidates') return json([]);
  return json({});
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const text = () => document.body.textContent ?? '';
const noCollectionsOption = () => screen.queryByRole('option', { name: 'No collections' });
const commonsLines = () => [...document.querySelectorAll('[data-commons-line]')].map((line) => line.textContent ?? '');
/** Every text the page showed while the test ran, not only at the end. */
let seen = '';
let watcher: MutationObserver | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  resetPersonSessionForTests();
  resetCommonsSessionForTests();
  resetLinesForTests();
  resetBackendConnectionForTests();
  window.sessionStorage.clear();
  for (const key of Object.keys(fails)) delete fails[key as Load];
  for (const key of Object.keys(held)) delete held[key as Load];
  transport.token = TOKEN;
  transport.fetch.mockReset();
  transport.fetch.mockImplementation(async (path: string) => answer(path));
  seen = '';
  watcher = new MutationObserver(() => { seen += `\n${text()}`; });
  watcher.observe(document.body, { subtree: true, childList: true, characterData: true });
});
afterEach(() => {
  watcher?.disconnect();
  cleanup();
  act(() => notePersonPromoted());
  act(() => resetBackendConnectionForTests());
  vi.useRealTimers();
});

describe('the references grid (GM r24 b)', () => {
  it('a failed search: only its failure line, never "No matches"', async () => {
    fails.search = 500;
    render(<CommonsView />);
    await tick(1000);
    expect(commonsLines()).toEqual(['Nebula couldn’t load the references because it didn’t respond. Try again.']);
    expect(seen).not.toContain(NO_MATCHES);
    expect(document.querySelector('.commons-empty')).toBeNull();
  });

  it('a real search with no results: "No matches…"', async () => {
    render(<CommonsView />);
    await tick(1000);
    expect(commonsLines()).toEqual([]);
    expect(screen.getByText(NO_MATCHES)).toBeTruthy();
  });

  it('the Inbox: its empty state only after its search answered', async () => {
    render(<CommonsView />);
    await tick(1000);
    fails.search = 500;
    fireEvent.click(screen.getByRole('tab', { name: 'Inbox' }));
    await tick(1000);
    expect(seen).not.toContain(INBOX_EMPTY);
    expect(screen.queryByText(NO_MATCHES)).toBeNull();
    delete fails.search;
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    await tick(1000);
    fireEvent.click(screen.getByRole('tab', { name: 'Inbox' }));
    await tick(1000);
    expect(screen.getByText(INBOX_EMPTY)).toBeTruthy();
  });

  it('a search that answered, then a refresh that failed: the empty state goes with it', async () => {
    render(<CommonsView />);
    await tick(1000);
    expect(screen.getByText(NO_MATCHES)).toBeTruthy();
    fails.search = 500;
    fireEvent.click(screen.getByRole('tab', { name: 'Inbox' }));
    await tick(1000);
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    await tick(1000);
    expect(screen.queryByText(NO_MATCHES)).toBeNull();
    expect(commonsLines()[0]).toMatch(/references/);
  });

  it('offline after a failed search, and back online before it reads again: still no empty state', async () => {
    fails.search = 500;
    render(<CommonsView />);
    await tick(1000);
    act(() => noteBackendConnection('offline'));
    await tick(300);
    expect(screen.queryByText(NO_MATCHES)).toBeNull();
    delete fails.search;
    let release: () => void = () => {};
    held.search = new Promise<void>((resolve) => { release = resolve; });
    act(() => noteBackendConnection('online'));
    await tick(1000);
    expect(screen.queryByText(NO_MATCHES)).toBeNull();
    release();
    await tick(100);
    expect(screen.getByText(NO_MATCHES)).toBeTruthy();
  });
});

describe('the Add to menu\'s collections (GM r24 b)', () => {
  it('a failed load: no "No collections"', async () => {
    fails.collections = 500;
    render(<CommonsView />);
    await tick(1000);
    // GM r24 c's shape for the collections.
    expect(commonsLines()).toEqual(['Nebula couldn’t load the collections because it didn’t respond. Try again.']);
    expect(noCollectionsOption()).toBeNull();
  });
  it('read, then a later read failed (back online): "No collections" goes with it', async () => {
    // A failed search, so the reconnect reads the page's loads again (useOfflineHiddenNotice).
    fails.search = 500;
    render(<CommonsView />);
    await tick(1000);
    expect(noCollectionsOption()).not.toBeNull();
    act(() => noteBackendConnection('offline'));
    await tick(300);
    fails.collections = 500;
    act(() => noteBackendConnection('online'));
    await tick(1000);
    expect(commonsLines().join(' ')).toMatch(/collections|the Commons/);
    expect(noCollectionsOption()).toBeNull();
  });
  it('none, read: "No collections"', async () => {
    render(<CommonsView />);
    await tick(1000);
    expect(noCollectionsOption()).not.toBeNull();
  });
});

describe('a tab that isn\'t connected as you (GM r24 b)', () => {
  it('neither an empty state nor a load\'s own line: the page line only', async () => {
    transport.token = null;
    act(() => reportPersonRequired());
    render(<CommonsView />);
    await tick(1000);
    expect(commonsLines()).toHaveLength(1);
    expect(commonsLines()[0]).toMatch(/^Nebula couldn’t load the Commons because this tab isn’t connected as you\./);
    expect(seen).not.toContain(NO_MATCHES);
    expect(noCollectionsOption()).toBeNull();
    expect(transport.fetch).not.toHaveBeenCalled();
  });
});

describe('Settings\' lists (GM r24 b)', () => {
  const settings = () => render(<CommonsSettings status={null} onOpenAsset={() => {}} onChanged={() => {}} />);
  it('a failed load: neither "No folders linked" nor "No new terms"', async () => {
    fails.folders = 500;
    settings();
    await tick(1000);
    // GM r25: the pane's own words, whichever of its reads failed.
    expect(text()).toContain('Nebula couldn’t load the Commons settings because it didn’t respond. Try again.');
    expect(seen).not.toContain(NO_FOLDERS);
    expect(seen).not.toContain(NO_TERMS);
  });
  it('before the read answers: neither; read and empty: both', async () => {
    let release: () => void = () => {};
    held.folders = new Promise<void>((resolve) => { release = resolve; });
    settings();
    await tick(1000);
    expect(seen).not.toContain(NO_FOLDERS);
    expect(seen).not.toContain(NO_TERMS);
    release();
    await tick(100);
    expect(screen.getByText(NO_FOLDERS)).toBeTruthy();
    expect(screen.getByText(NO_TERMS)).toBeTruthy();
  });
});
