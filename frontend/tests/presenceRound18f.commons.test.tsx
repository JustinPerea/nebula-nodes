/**
 * PR #204 round 18f: review 15 and GM r35, on the real Commons screens with the real Commons API
 * (only apiFetch is stubbed).
 * - Focus when the Commons turns off mid-visit goes to the heading, by the one handover rule
 *   (review 15 MEDIUM-1, GM r35 1).
 * - A collection made while the list's re-read failed joins the kept list: Add to shows what Add
 *   sends to (review 15 MEDIUM-1 of the logic lens, its probe P6).
 * - Any answer proving the Commons is on clears the off line; only the 404 "disabled" sets it; no
 *   answer leaves it (GM r35 2, review 15 LOW-1, probes P1/P1b; NIT-3 M1/M14).
 * - A linked folder's own name once the read-back has it (GM r35 3, NIT-2).
 * - A load line's "Try again" button, and the silent re-read on reconnect (GM r35 4).
 * - NIT-3's other survivors: the settings read-back while off (M15), the loading line's timer (M17).
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
const { CommonsSettings } = await import('../src/components/commons/CommonsSettings');
const { CommonsReview } = await import('../src/components/commons/CommonsReview');
const { CommonsDetail } = await import('../src/components/commons/CommonsDetail');
const { notePersonPromoted, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');
const { noteBackendConnection, resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
const { lineLook, NEUTRAL } = await import('./helpers/lineLook');
const { CommonsLoadingLine } = await import('../src/components/commons/CommonsLoadingLine');
const { isCommonsOff, retryStem, loadFailedLine } = await import('../src/lib/errorCopy');
const { commonsOffNow } = await import('../src/lib/commonsOff');
const { withCollection } = await import('../src/lib/commonsFormat');
const { RequestFailedError } = await import('../src/lib/errorCopy');

const OFF = 'Commons is turned off for this Nebula.';
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
const text = () => document.body.textContent ?? '';
const commonsLines = () => [...document.querySelectorAll('[data-commons-line]')].map((line) => line.textContent ?? '');
const select = () => document.querySelector<HTMLSelectElement>('.commons-field--inline select');
const add = () => document.querySelector<HTMLButtonElement>('.commons-add > button');
/** Every text and accessible name the page showed while the test ran, not only at the end. */
let seen = '';
let watcher: MutationObserver | null = null;
const record = () => {
  seen += `\n${text()}`;
  for (const el of document.querySelectorAll('[aria-label], [title]')) seen += `\n${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`;
};

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
  seen = '';
  watcher = new MutationObserver(record);
  watcher.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
});
afterEach(() => {
  watcher?.disconnect();
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

describe('focus when the Commons turns off mid-visit goes to the heading (review 15 MEDIUM-1, GM r35 1)', () => {
  it.each(['Inbox', 'Agent review'])('from the %s tab', async (name) => {
    render(<CommonsView />);
    await tick(1000);
    act(() => tab(name).focus());
    await offNow();
    expectOffView('off');
    expect(document.activeElement).toBe(heading());
  });

  it('from a Settings field', async () => {
    render(<CommonsView />);
    await tick(1000);
    fireEvent.click(tab('Settings'));
    await tick(1000);
    const field = screen.getByRole('textbox', { name: 'Folder path' });
    act(() => field.focus());
    await offNow();
    expectOffView('off');
    expect(document.activeElement).toBe(heading());
  });

  it('from the detail view', async () => {
    rows.list = [{ id: 'a1', membership_id: 'm1', collection_id: 'c1', collection: 'Refs', summary: 'A ref', role: 'neutral',
      media: 'image', made_by: 'unknown', analysis_state: 'ready', in_inbox: false, comment_count: 0, matched: [], score: 1,
      blob_key: 'k', also_in: [] }];
    render(<CommonsView />);
    await tick(1000);
    fireEvent.click(document.querySelector<HTMLElement>('.commons-tile, [data-asset-id], .commons-grid button')!);
    await tick(1000);
    const close = screen.getByRole('button', { name: /^Close/ });
    act(() => close.focus());
    await offNow();
    expectOffView('off');
    expect(document.querySelector('.commons-detail')).toBeNull();
    expect(document.activeElement).toBe(heading());
  });

  it('from an action\'s 404 "disabled", with no offline step', async () => {
    lists.collections = [{ id: 'c1', name: 'Refs', kind: 'manual' }];
    render(<CommonsView />);
    await tick(1000);
    act(() => tab('Inbox').focus());
    commonsOff.on = true;
    fireEvent.click(add()!);
    await tick(10);
    const box = screen.getByRole('textbox', { name: 'Image or page URL' });
    fireEvent.change(box, { target: { value: 'https://example.invalid/a.png' } });
    act(() => tab('Inbox').focus());
    fireEvent.submit(box.closest('form')!);
    await tick(1000);
    expectOffView('off');
    expect(document.activeElement).toBe(heading());
  });
});

describe('a collection made while the re-read failed joins the kept list (review 15 P6)', () => {
  it('the select shows the new collection, and Add sends to it', async () => {
    lists.collections = [{ id: 'c1', name: 'Refs', kind: 'manual' }];
    render(<CommonsView />);
    await tick(1000);
    fails.collections = [503];
    fireEvent.change(select()!, { target: { value: '__new__' } });
    await tick(10);
    fireEvent.change(screen.getByRole('textbox', { name: /New collection name/ }), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await tick(2000);
    const sel = select()!;
    expect(sel.value).toBe('c2');
    expect(sel.options[sel.selectedIndex].textContent).toBe('New');
    expect([...sel.options].map((o) => o.value)).toEqual(['c1', 'c2', '__new__']);
    fireEvent.click(add()!);
    await tick(10);
    const box = screen.getByRole('textbox', { name: 'Image or page URL' });
    fireEvent.change(box, { target: { value: 'https://example.invalid/a.png' } });
    fireEvent.submit(box.closest('form')!);
    await tick(100);
    const sent = bodies.filter((b) => b.path.endsWith('/intake/url')).map((b) => JSON.parse(b.body).collection_id);
    expect(sent).toEqual(['c2']);
  });

  it('withCollection adds it once', () => {
    const a = { id: 'c1', name: 'Refs' } as never;
    const b = { id: 'c2', name: 'New' } as never;
    expect(withCollection([a], b)).toEqual([a, b]);
    expect(withCollection([a, b], b)).toEqual([a, b]);
  });
});

describe('only the 404 "disabled" sets the off line; any answer proving the Commons is on clears it (GM r35 2)', () => {
  it('a 500 after the off view: the real load line replaces the off line, neutral', async () => {
    commonsOff.on = true;
    render(<CommonsView />);
    await tick(3000);
    expectOffView('off');
    commonsOff.on = false;
    every.answer = [500, 'boom'];
    await tick(5100);
    expect(commonsOffNow()).toBe(false);
    expect(screen.getByRole('tablist')).toBeTruthy();
    await tick(3000);
    const lines = commonsLines();
    expect(lines).not.toContain(OFF);
    expect(lines).toEqual(['Nebula couldn’t load Commons because the server hit an error. Try again.']);
    const line = document.querySelector('[data-commons-line]')!;
    expect(line.hasAttribute('data-line-neutral')).toBe(true);
    expect(lineLook(line)).toEqual(NEUTRAL);
  });

  it('a 401 after the off view: the not-connected line replaces the off line', async () => {
    commonsOff.on = true;
    render(<CommonsView />);
    await tick(3000);
    commonsOff.on = false;
    every.answer = [401, 'no UI session'];
    await tick(5100);
    expect(commonsOffNow()).toBe(false);
    await tick(3000);
    expect(text()).not.toContain(OFF);
    expect(commonsLines().join('\n')).toContain('this tab isn’t connected as you');
  });

  it.each([
    ['a 500 that says "Commons is disabled" (M1/M14)', 500, 'Commons is disabled'],
    ['a 409 that says "Commons is disabled" (M1/M14)', 409, 'Commons is disabled'],
    ['a plain 404', 404, 'not found'],
    ['a 403', 403, undefined],
  ])('%s proves the Commons is on', async (_, status, detail) => {
    commonsOff.on = true;
    render(<CommonsView />);
    await tick(3000);
    commonsOff.on = false;
    every.answer = [status, detail];
    await tick(5100);
    expect(commonsOffNow()).toBe(false);
    expect(text()).not.toContain(OFF);
  });

  it.each([
    ['a gateway 502 with no reason', [502, undefined] as [number, unknown]],
    ['a gateway 504 with no reason', [504, undefined] as [number, unknown]],
  ])('%s says nothing: the off view stays', async (_, given) => {
    commonsOff.on = true;
    render(<CommonsView />);
    await tick(3000);
    commonsOff.on = false;
    every.answer = given;
    await tick(5100);
    expect(commonsOffNow()).toBe(true);
    expectOffView('still off');
  });

  it('no answer says nothing: the off view stays', async () => {
    commonsOff.on = true;
    render(<CommonsView />);
    await tick(3000);
    commonsOff.on = false;
    transport.fetch.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    await tick(5100);
    expect(commonsOffNow()).toBe(true);
    expectOffView('still off');
  });

  it('isCommonsOff is the 404 alone (M14)', () => {
    expect(isCommonsOff(new RequestFailedError('x', 404, { detail: 'Commons is disabled' }))).toBe(true);
    expect(isCommonsOff(new RequestFailedError('x', 500, { detail: 'Commons is disabled' }))).toBe(false);
    expect(isCommonsOff(new RequestFailedError('x', 409, { detail: 'Commons is disabled' }))).toBe(false);
  });
});

describe('a load line\'s "Try again" button (GM r35 4)', () => {
  const COLLECTIONS = 'Nebula couldn’t load the collections because the server didn’t respond. Try again.';

  it('ends the collections line, neutral, inline; it re-reads, and the line goes once a read succeeds', async () => {
    lists.collections = [{ id: 'c1', name: 'Refs', kind: 'manual' }];
    fails.collections = [503];
    render(<CommonsView />);
    await tick(3000);
    expect(commonsLines()).toEqual([COLLECTIONS]);
    const button = retry()!;
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.closest('[data-commons-line]')?.hasAttribute('data-line-neutral')).toBe(true);
    expect(button.className).toBe('commons-retry');
    // One sentence: the words read the same, the button is its last two words.
    expect(button.closest('[data-commons-line]')!.textContent).toBe(COLLECTIONS);
    // Still failing: read again, the line stays.
    const before = reads('collections');
    fireEvent.click(button);
    await tick(2000);
    expect(reads('collections')).toBe(before + 1);
    expect(commonsLines()).toEqual([COLLECTIONS]);
    // Answering now: the line goes, with no timer, and focus on its button goes to the heading.
    delete fails.collections;
    act(() => retry()!.focus());
    fireEvent.click(retry()!);
    await tick(2000);
    expect(commonsLines()).toEqual([]);
    expect(retry()).toBeNull();
    expect(document.activeElement).toBe(heading());
    expect(select()!.value).toBe('c1');
  });

  it('no button before a read is asked for: nothing re-reads by a timer', async () => {
    fails.collections = [503];
    render(<CommonsView />);
    await tick(3000);
    const before = reads('collections');
    await tick(60_000);
    expect(reads('collections')).toBe(before);
  });

  it('re-reads silently on reconnect, and the line goes once it answers', async () => {
    fails.collections = [503];
    render(<CommonsView />);
    await tick(3000);
    expect(commonsLines()).toEqual([COLLECTIONS]);
    act(() => noteBackendConnection('offline'));
    await tick(100);
    delete fails.collections;
    act(() => noteBackendConnection('online'));
    await tick(2000);
    expect(commonsLines()).toEqual([]);
  });

  it('an action\'s line has no button (it would send the action again)', async () => {
    lists.collections = [{ id: 'c1', name: 'Refs', kind: 'manual' }];
    postFails['/api/commons/collections'] = 503;
    render(<CommonsView />);
    await tick(1000);
    fireEvent.change(select()!, { target: { value: '__new__' } });
    await tick(10);
    fireEvent.change(screen.getByRole('textbox', { name: /New collection name/ }), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await tick(2000);
    expect(commonsLines().length).toBe(1);
    expect(retry()).toBeNull();
  });

  it('the Settings pane\'s load line has it too, and it reads the settings again', async () => {
    fails.settings = [503];
    render(<CommonsSettings status={null} onOpenAsset={() => {}} onChanged={() => {}} />);
    await tick(1000);
    expect(commonsLines()).toEqual(['Nebula couldn’t load Commons settings because the server didn’t respond. Try again.']);
    delete fails.settings;
    fireEvent.click(retry()!);
    await tick(1000);
    expect(commonsLines()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Link folder' })).toBeTruthy();
  });

  it('Agent review\'s and a reference\'s load lines have it', async () => {
    fails.review = [500];
    render(<CommonsReview active onWork={() => {}} />);
    await tick(1000);
    expect(retry()).toBeTruthy();
    cleanup();
    render(<CommonsDetail assetId="a1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
    await tick(1000);
    expect(commonsLines()).toEqual(['Nebula couldn’t load this reference because the server hit an error. Try again.']);
    expect(retry()).toBeTruthy();
  });

  it('retryStem: only a load line that ends "Try again."', () => {
    expect(retryStem(COLLECTIONS)).toBe('Nebula couldn’t load the collections because the server didn’t respond.');
    expect(retryStem('Nebula couldn’t load the collections because the server isn’t answering. Check that Nebula is running, then try again.')).toBeNull();
    expect(retryStem('Nebula couldn’t load the collections because the server is busy. Try again in a moment.')).toBeNull();
    expect(retryStem('Couldn’t create the collection. The server didn’t respond. Try again.')).toBeNull();
    expect(retryStem('Saved. Nebula couldn’t load the settings back because the server didn’t respond. Reload to see them.')).toBeNull();
    expect(retryStem(OFF)).toBeNull();
    expect(loadFailedLine('load the collections', new RequestFailedError('x', 503))).toBe(COLLECTIONS);
  });
});

describe('a linked folder\'s own name (GM r35 3, review 15 NIT-2)', () => {
  const link = async (typed: string) => {
    render(<CommonsSettings status={null} onOpenAsset={() => {}} onChanged={() => {}} />);
    await tick(1000);
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder path' }), { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: 'Link folder' }));
  };
  const notice = () => document.querySelector<HTMLElement>('.commons-notice[role="status"]');

  it('the typed text until the read-back has it, then the resolved folder\'s name', async () => {
    folderState.linked = { id: 'f9', path: '/Users/me', ignores: [] };
    let release = () => {};
    await link('~');
    held.folders = new Promise((resolve) => { release = resolve; });
    await tick(10);
    expect(notice()?.textContent).toBe('Linked “~”. Scanning it now.');
    expect(notice()?.title).toBe('~');
    folderState.list = [{ id: 'f9', path: '/Users/me', ignores: [], last_scan_at: null, last_scan_summary: null, device_states: [] }];
    release();
    await tick(100);
    expect(notice()?.textContent).toBe('Linked “me”. Scanning it now.');
    expect(notice()?.title).toBe('/Users/me');
  });

  it('a failed read-back keeps the typed text', async () => {
    folderState.linked = { id: 'f9', path: '/a', ignores: [] };
    await link('/a/b/..');
    fails.folders = [503];
    await tick(200);
    expect(notice()?.textContent).toBe('Linked “..”. Scanning it now.');
    expect(notice()?.title).toBe('/a/b/..');
  });

  it.each(['Re-analyze stale', 'Import moodboards'])('%s clears the title', async (name) => {
    folderState.linked = { id: 'f9', path: '/a/refs', ignores: [] };
    folderState.list = [{ id: 'f9', path: '/a/refs', ignores: [], last_scan_at: null, last_scan_summary: null, device_states: [] }];
    await link('/a/refs');
    await tick(200);
    expect(notice()?.title).toBe('/a/refs');
    fireEvent.click(screen.getByRole('button', { name }));
    await tick(200);
    expect(notice()?.textContent).not.toContain('Linked');
    expect(notice()?.hasAttribute('title')).toBe(false);
  });
});

describe('review 15 NIT-3: the other survivors', () => {
  it('a settings read-back refused because the Commons is off says no "Saved…" line (M15)', async () => {
    render(<CommonsSettings status={null} onOpenAsset={() => {}} onChanged={() => {}} />);
    await tick(1000);
    folderState.offAfterPost = true;
    fireEvent.change(screen.getByRole('textbox', { name: 'Folder path' }), { target: { value: '/a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link folder' }));
    await tick(500);
    expect(seen).not.toContain('Saved.');
    expect(commonsLines()).toEqual([]);
  });

  it('the loading line leaves no timer behind when it goes before 300 ms (M17)', () => {
    const before = vi.getTimerCount();
    const { unmount } = render(<CommonsLoadingLine text="Loading settings…" />);
    expect(vi.getTimerCount()).toBe(before + 1);
    unmount();
    expect(vi.getTimerCount()).toBe(before);
  });
});
