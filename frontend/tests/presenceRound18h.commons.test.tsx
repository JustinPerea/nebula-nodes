/**
 * PR #204 round 18h: review 16's mutation gaps on the Commons screen (logic NIT-2), with round
 * 18f's harness (the real Commons API; only apiFetch is stubbed).
 * - N20: the page row's Try again reads every page load again (status and references too).
 * - N22: the spring never shows while the Commons is off.
 * - N12: the opening mark is used once: a later ordinary entry neither springs nor takes focus.
 * - N21: the Commons turning off is part of the handover's change: it alone moves focus on.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADD_NAME, ADD_TO_NAME } from './helpers/commonsAddNames';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), token: null as string | null }));
vi.mock('../src/lib/backend', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch }));
vi.mock('../src/lib/personSession', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/personSession')>(),
  personToken: async () => transport.token,
}));
vi.mock('../src/components/commons/CommonsEvaluation', () => ({ CommonsEvaluation: () => null }));
vi.mock('../src/components/commons/CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../src/components/agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => null }));

const { CommonsView } = await import('../src/components/commons/CommonsView');
const { notePersonPromoted, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');
const { resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
const { markCommonsOpening, peekCommonsOpening } = await import('../src/lib/commonsOpening');

// A cold first render can take seconds on a busy machine (presenceRound15.paneLoads does the same).
vi.setConfig({ testTimeout: 30_000 });
const RAW = 'ZZRAW backend words';
const TOKEN = 'a'.repeat(43);
type Load = 'status' | 'collections' | 'search' | 'folders' | 'settings' | 'candidates' | 'review';
const fails: Partial<Record<Load, [number, unknown?]>> = {};
const held: Partial<Record<Load, Promise<void>>> = {};
const lists = { collections: [] as unknown[], running: false };
const posts: string[] = [];
const commonsOff = { on: false };
/** Status reads still answered before the rest hang (null: all answer). */
const statusGate = { answers: null as number | null };
const postFails: Record<string, number> = {};
/** Round 18f: the next answers for every Commons call, in place of the usual (status, detail). */
const every = { answer: null as [number, unknown] | null };
/** The search's rows, and whether a reference's detail read fails. */
const rows = { list: [] as unknown[] };
/** The folders the read-back lists, and what linking answers. */
const folderState = { list: [] as unknown[], linked: { id: 'f1', path: '/x', ignores: [] } as unknown, offAfterPost: false };
const bodies: { path: string; body: string }[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function answer(path: string, init?: RequestInit): Promise<Response> {
  const post = init?.method === 'POST' && !path.endsWith('/search');
  const load = (['status', 'collections', 'search', 'folders', 'settings', 'candidates', 'review'] as const).find((name) => path.endsWith(`/${name}`));
  if (!post && load && held[load]) await held[load];
  if (load === 'status' && !commonsOff.on && statusGate.answers !== null && statusGate.answers-- <= 0) await new Promise(() => {});
  if (commonsOff.on) return json({ detail: 'Commons is disabled' }, 404);
  if (every.answer) return json(every.answer[1] === undefined ? {} : { detail: every.answer[1] }, every.answer[0]);
  if (post) {
    posts.push(path);
    bodies.push({ path, body: String(init?.body ?? '') });
    if (folderState.offAfterPost) commonsOff.on = true;
    if (postFails[path]) return json({ detail: RAW }, postFails[path]);
    if (path.endsWith('/collections')) return json({ id: 'c2', name: 'New', kind: 'manual' });
    if (path.endsWith('/folders')) return json(folderState.linked);
    if (path.endsWith('/import-moodboards') || path.includes('moodboard')) return json({ collections: 0, added: 0, skipped: [] });
    if (path.endsWith('/reanalyze-stale')) return json({ queued: 0 });
    return json({ id: 'a1', kind: 'asset', asset_id: 'a1' });
  }
  if (path.includes('/assets/')) return json({ detail: 'boom' }, 500);
  if (load && fails[load]) return json({ detail: fails[load]![1] ?? 'no' }, fails[load]![0]);
  if (load === 'status') return json({ worker: { running: lists.running, state: 'idle' }, queue: {}, meter: { calls: 0, cap: 100, remaining: 100, resets_at: '2026-11-02T00:00:00Z' } });
  if (load === 'collections') return json(lists.collections);
  if (load === 'search') return json({ results: rows.list });
  if (load === 'folders') return json(folderState.list);
  if (load === 'candidates') return json([]);
  if (load === 'settings') return json({ daily_cap: 100 });
  if (load === 'review') return json(null);
  return json({});
}

const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const commonsLines = () => [...document.querySelectorAll('[data-commons-line]')].map((line) => line.textContent ?? '');

beforeEach(() => {
  vi.useFakeTimers();
  document.body.className = 'app-slava-restraint';
  resetPersonSessionForTests();
  resetCommonsSessionForTests();
  resetLinesForTests();
  resetBackendConnectionForTests();
  window.sessionStorage.clear();
  for (const key of Object.keys(fails)) delete fails[key as Load];
  for (const key of Object.keys(held)) delete held[key as Load];
  for (const key of Object.keys(postFails)) delete postFails[key];
  commonsOff.on = false;
  statusGate.answers = null;
  every.answer = null;
  rows.list = [];
  folderState.list = [];
  folderState.linked = { id: 'f1', path: '/x', ignores: [] };
  folderState.offAfterPost = false;
  bodies.length = 0;
  transport.token = TOKEN;
  transport.fetch.mockReset();
  transport.fetch.mockImplementation(async (path: string, init?: RequestInit) => answer(path, init));
  lists.collections = [];
  lists.running = false;
  posts.length = 0;
});
afterEach(() => {
  cleanup();
  act(() => notePersonPromoted());
  act(() => resetBackendConnectionForTests());
  resetCommonsSessionForTests();
  vi.useRealTimers();
  document.body.className = '';
});

/** Layout M: only the way back, the title and Updates in the header. */
function expectOffView(where: string) {
  expect(screen.queryByRole('tablist'), where).toBeNull();
  expect(screen.queryByRole('tab'), where).toBeNull();
  expect(screen.queryByRole('combobox', { name: ADD_TO_NAME }), where).toBeNull();
  expect(screen.queryByRole('button', { name: ADD_NAME }), where).toBeNull();
  expect(screen.queryByRole('button', { name: /^(Start|Stop|More)\b/ }), where).toBeNull();
  expect(document.querySelector('.commons-status, .commons-tabs, .commons-add, .commons-field--inline'), where).toBeNull();
  expect(document.querySelector('.commons-main, .commons-filters, .commons-panel-slot, .commons-settings'), where).toBeNull();
  expect(screen.getByRole('heading', { name: 'Commons', level: 1 }), where).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Back to Canvas' }), where).toBeTruthy();
}


const heading = () => screen.getByRole('heading', { name: 'Commons', level: 1 });
const offNow = async () => { commonsOff.on = true; await tick(5100); };
const tab = (name: string) => screen.getByRole('tab', { name });
const retry = () => screen.queryByRole('button', { name: 'Try again' });
const reads = (load: string) => transport.fetch.mock.calls.filter(([path, init]) => String(path).endsWith(`/${load}`) && (init as RequestInit | undefined)?.method !== 'POST').length;

describe('review 16 NIT-2: the page row and the opening', () => {
  it('N20: the page row\'s Try again reads the status and the references again, not only the collections', async () => {
    fails.status = [503];
    render(<CommonsView />);
    await tick(3000);
    expect(commonsLines().join(' ')).toMatch(/Try again\.$/);
    const status = reads('status');
    // The references' read is a POST /search.
    const searches = () => transport.fetch.mock.calls.filter(([path]) => String(path).endsWith('/search')).length;
    const search = searches();
    const collections = reads('collections');
    fireEvent.click(retry()!);
    // Within the search's debounce, short of the status poll's 5 s.
    await tick(1500);
    expect(reads('status')).toBe(status + 1);
    expect(searches()).toBe(search + 1);
    expect(reads('collections')).toBe(collections + 1);
  });

  it('N22: the spring shows when the Commons comes back, and never while it is off', async () => {
    render(<CommonsView />);
    await tick(1000);
    const view = () => document.querySelector('.commons-view');
    expect(view()!.hasAttribute('data-commons-opening')).toBe(false);
    await offNow();
    expectOffView('off');
    commonsOff.on = false;
    await tick(5100);
    // Back: the sections spring in (jsdom runs no animation, so the mark stays).
    expect(view()!.hasAttribute('data-commons-opening')).toBe(true);
    await offNow();
    expectOffView('off again');
    expect(view()!.hasAttribute('data-commons-opening')).toBe(false);
  });

  it('N12: the opening mark is used once; a later entry neither springs nor takes focus', async () => {
    markCommonsOpening('heading');
    const first = render(<CommonsView />);
    await tick(1000);
    expect(document.activeElement).toBe(heading());
    expect(peekCommonsOpening()).toBeNull();
    first.unmount();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    render(<CommonsView />);
    await tick(1000);
    expect(document.activeElement).not.toBe(heading());
    expect(document.querySelector('.commons-view')!.hasAttribute('data-commons-opening')).toBe(false);
  });

  it('N21: the Commons turning off alone (no offline, no new view) moves focus from a tab to the heading', async () => {
    render(<CommonsView />);
    await tick(1000);
    act(() => tab('Inbox').focus());
    await offNow();
    expect(document.activeElement).toBe(heading());
  });
});
