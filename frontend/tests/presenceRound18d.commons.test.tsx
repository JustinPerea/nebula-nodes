/**
 * PR #204 round 18d: GM r31 and r32, and review 14's findings, on the real Commons screens with the
 * real Commons API (only apiFetch is stubbed).
 * - The Commons turned off (GM r31 layout M, GM r32 1): the header keeps only the way back, the
 *   title and Updates; no sections, Add to, Add, status, Start or Stop; one line, "Commons is
 *   turned off for this Nebula."; an action's 404 turns to that view; "Commons is disabled" never
 *   shows; going offline and back never brings the sections back (review 14 LOW-2).
 * - Add to after a failed re-read keeps its last good list, live, beside the neutral line (GM r32
 *   2, review 14 LOW-3).
 * - A settings write that landed, whose read-back failed (GM r32 3, review 14 LOW-1, probe P3).
 * - The grid says nothing while the collections haven't loaded (GM r32 4, live LOW-2).
 * - One loading look (GM r32 5, live NIT-2); a pane's load line hides offline (live LOW-1).
 * - Review 14 NIT-1's surviving mutants.
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
const { CommonsErrorLine } = await import('../src/components/commons/CommonsErrorLine');
const { isLoadLine, notConnectedBecause, savedReadBackLine } = await import('../src/lib/errorCopy');
const { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } = await import('../src/lib/personSession');
const { resetCommonsSessionForTests } = await import('../src/lib/commonsApi');
const { resetLinesForTests } = await import('../src/lib/notConnectedLine');
const { noteBackendConnection, resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
const { lineLook, NEUTRAL } = await import('./helpers/lineLook');

const OFF = 'Commons is turned off for this Nebula.';
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
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function answer(path: string, init?: RequestInit): Promise<Response> {
  const post = init?.method === 'POST' && !path.endsWith('/search');
  const load = (['status', 'collections', 'search', 'folders', 'settings', 'candidates', 'review'] as const).find((name) => path.endsWith(`/${name}`));
  if (!post && load && held[load]) await held[load];
  if (load === 'status' && !commonsOff.on && statusGate.answers !== null && statusGate.answers-- <= 0) await new Promise(() => {});
  if (commonsOff.on) return json({ detail: 'Commons is disabled' }, 404);
  if (post) {
    posts.push(path);
    if (postFails[path]) return json({ detail: RAW }, postFails[path]);
    if (path.endsWith('/collections')) return json({ id: 'c2', name: 'New', kind: 'manual' });
    return json({ id: 'f1', path: '/x', ignores: [] });
  }
  if (load && fails[load]) return json({ detail: fails[load]![1] ?? 'no' }, fails[load]![0]);
  if (load === 'status') return json({ worker: { running: lists.running, state: 'idle' }, queue: {}, meter: { calls: 0, cap: 100, remaining: 100, resets_at: '2026-11-02T00:00:00Z' } });
  if (load === 'collections') return json(lists.collections);
  if (load === 'search') return json({ results: [] });
  if (load === 'folders' || load === 'candidates') return json([]);
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

describe('the Commons turned off (GM r31 layout M, GM r32 1)', () => {
  it('the header keeps only the way back and the title; one line; "Commons is disabled" never shows', async () => {
    commonsOff.on = true;
    render(<CommonsView />);
    await tick(3000);
    expectOffView('off');
    expect(commonsLines()).toEqual([OFF]);
    expect(seen).not.toContain('Commons is disabled');
  });

  it('an action\'s 404 "disabled" turns to the off view: the status read before and Start go', async () => {
    render(<CommonsView />);
    await tick(1000);
    const start = screen.getByRole('button', { name: 'Start' });
    expect(screen.getByRole('tablist')).toBeTruthy();
    commonsOff.on = true;
    fireEvent.click(start);
    await tick(50);
    expectOffView('after Start');
    expect(commonsLines()).toEqual([OFF]);
    expect(seen).not.toContain('Commons is disabled');
    expect(seen).not.toContain('Couldn’t start');
    // The status poll keeps getting the 404: still off, no status, no Start.
    await tick(6000);
    expectOffView('after the next poll');
    // Back on: the Start that failed left no line behind.
    commonsOff.on = false;
    await tick(5100);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(commonsLines()).toEqual([]);
    expect(text()).not.toContain('Couldn’t start');
  });

  it('an action refused while on Settings (no search there to clear it) leaves no line once the Commons is back', async () => {
    render(<CommonsView />);
    await tick(1000);
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    await tick(1000);
    commonsOff.on = true;
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await tick(50);
    expectOffView('after Start');
    commonsOff.on = false;
    await tick(5100);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(commonsLines()).toEqual([]);
    expect(seen).not.toContain('Couldn’t start');
  });

  it('the status read before the Commons went off never shows again: back on, it reads again first', async () => {
    lists.running = true;
    render(<CommonsView />);
    await tick(1000);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    commonsOff.on = true;
    await tick(5100);
    expectOffView('off');
    // Back on: the poll's read answers (the Commons is back), and the fresh read it starts is
    // still on its way: no stale "Idle" and Stop meanwhile.
    statusGate.answers = 1;
    commonsOff.on = false;
    await tick(5100);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(document.querySelector('.commons-status')!.textContent).not.toContain('Idle');
  });

  it('an Add menu open when the Commons goes off is closed when it comes back', async () => {
    lists.collections = [{ id: 'c1', name: 'Refs', kind: 'manual' }];
    render(<CommonsView />);
    await tick(1000);
    fireEvent.click(add()!);
    expect(screen.getByRole('menu')).toBeTruthy();
    commonsOff.on = true;
    await tick(5100);
    expectOffView('off');
    commonsOff.on = false;
    await tick(5100);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(add()!.getAttribute('aria-expanded')).toBe('false');
  });

  it('offline and back: the sections never come back, not even for a frame', async () => {
    commonsOff.on = true;
    render(<CommonsView />);
    await tick(3000);
    let flashed = false;
    const mo = new MutationObserver(() => { if (document.querySelector('[role="tablist"], .commons-main, .commons-status')) flashed = true; });
    mo.observe(document.body, { subtree: true, childList: true });
    act(() => noteBackendConnection('offline'));
    await tick(500);
    expectOffView('offline');
    // Offline comes first: the off line hides beside "Nebula is offline", the view stays, and
    // the page row with it (no empty row).
    expect(commonsLines()).toEqual([]);
    expect(document.querySelector('[data-page-lines]')).toBeNull();
    act(() => noteBackendConnection('online'));
    for (let i = 0; i < 30; i += 1) await tick(100);
    mo.disconnect();
    expect(flashed).toBe(false);
    expectOffView('back online');
    expect(commonsLines()).toEqual([OFF]);
  });

  it('a Commons read that answers brings the Commons back', async () => {
    commonsOff.on = true;
    render(<CommonsView />);
    await tick(3000);
    expectOffView('off');
    commonsOff.on = false;
    await tick(5100);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(commonsLines()).toEqual([]);
  });
});

describe('Add to after a failed re-read (GM r32 2, review 14 LOW-3)', () => {
  it('keeps the last good list, live, beside the neutral line; Try again re-reads', async () => {
    lists.collections = [{ id: 'c1', name: 'Refs', kind: 'manual' }];
    fails.search = [500];
    render(<CommonsView />);
    await tick(1000);
    expect([...select()!.options].map((o) => o.textContent)).toEqual(['Refs', 'New collection…']);
    act(() => noteBackendConnection('offline'));
    await tick(300);
    fails.collections = [503];
    act(() => noteBackendConnection('online'));
    await tick(2000);
    expect([...select()!.options].map((o) => o.textContent)).toEqual(['Refs', 'New collection…']);
    expect(select()!.hasAttribute('aria-disabled')).toBe(false);
    expect(add()!.hasAttribute('aria-disabled')).toBe(false);
    expect(commonsLines()).toContain('Nebula couldn’t load the collections because the server didn’t respond. Try again.');
    // Add works with the list kept.
    fireEvent.click(add()!);
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(add()!.getAttribute('aria-expanded')).toBe('true');
  });

  it('a menu Add opened, a demote, then the promote with the collections not read yet: closed, not expanded, until they load', async () => {
    lists.collections = [{ id: 'c1', name: 'Refs', kind: 'manual' }];
    render(<CommonsView />);
    await tick(1000);
    fireEvent.click(add()!);
    expect(screen.getByRole('menu')).toBeTruthy();
    act(() => reportPersonRequired());
    await tick(500);
    expect(screen.queryByRole('menu')).toBeNull();
    let release = () => {};
    held.collections = new Promise<void>((resolve) => { release = resolve; });
    act(() => notePersonPromoted());
    await tick(500);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(add()!.getAttribute('aria-expanded')).toBe('false');
    expect(add()!.getAttribute('aria-disabled')).toBe('true');
    release();
    delete held.collections;
    await tick(500);
    // GM r19 2: Add's menu comes back with the promote, once Add works again.
    expect(add()!.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('the grid while the collections haven\'t loaded (GM r32 4, live LOW-2, NIT-1)', () => {
  it('nothing in the grid: no "No matches", no drop hint', async () => {
    held.collections = new Promise(() => {});
    render(<CommonsView />);
    await tick(1000);
    expect(seen).not.toContain('No matches');
    expect(document.querySelector('.commons-empty')).toBeNull();
  });
  it('a drag over the grid isn\'t taken; a drop sends nothing and asks for nothing', async () => {
    held.collections = new Promise(() => {});
    render(<CommonsView />);
    await tick(1000);
    const wrap = document.querySelector('.commons-grid-wrap')!;
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'copy' };
    fireEvent.dragOver(wrap, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe('none');
    expect(wrap.classList.contains('commons-grid-wrap--dragging')).toBe(false);
    fireEvent.drop(wrap, { dataTransfer });
    await tick(100);
    expect(posts).toEqual([]);
    expect(seen).not.toContain('Pick or create a collection first.');
  });
});

describe('a settings write that landed, whose read-back failed (GM r32 3, review 14 LOW-1, probe P3)', () => {
  const link = async () => {
    fireEvent.change(screen.getByPlaceholderText('/Users/you/Pictures/refs'), { target: { value: '/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link folder' }));
    await tick(1000);
  };
  for (const [status, detail, cause] of [
    [409, RAW, 'the server didn’t accept it'], [503, undefined, 'the server didn’t respond'],
    [500, undefined, 'the server hit an error'], [429, undefined, 'the server is busy'],
  ] as const) {
    it(`${status}: "Saved. …", neutral, no Try again, no backend words`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      render(<CommonsSettings status={null} onOpenAsset={() => {}} onChanged={() => {}} />);
      await tick(1000);
      fails.folders = [status, detail];
      await link();
      expect(posts).toEqual(['/api/commons/folders']);
      const line = `Saved. Nebula couldn’t load the settings back because ${cause}. Reload to see them.`;
      expect(line).toBe(savedReadBackLine(cause));
      expect(commonsLines()).toEqual([line]);
      const box = document.querySelector('[data-commons-line]')!;
      expect(box.hasAttribute('data-line-neutral')).toBe(true);
      expect(lineLook(box)).toEqual(NEUTRAL);
      expect(seen).not.toContain('ZZRAW');
      expect(seen).not.toContain('Try again');
      // The form stays, with the write's own message.
      expect(screen.getByText('Linked /x; scanning.')).toBeTruthy();
      warn.mockRestore();
    });
  }
  it('the write itself refused: the action\'s line, in the error look', async () => {
    render(<CommonsSettings status={null} onOpenAsset={() => {}} onChanged={() => {}} />);
    await tick(1000);
    fireEvent.change(screen.getByPlaceholderText('/Users/you/Pictures/refs'), { target: { value: '/x' } });
    postFails['/api/commons/folders'] = 500;
    fireEvent.click(screen.getByRole('button', { name: 'Link folder' }));
    await tick(1000);
    const lines = commonsLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Couldn’t link the folder\./);
    expect(document.querySelector('[data-commons-line]')!.hasAttribute('data-line-neutral')).toBe(false);
  });
});

describe('New collection… landed, the list\'s read-back failed (review 14 LOW-1)', () => {
  it('the collections\' load line, neutral, never the action\'s', async () => {
    lists.collections = [{ id: 'c1', name: 'Refs', kind: 'manual' }];
    render(<CommonsView />);
    await tick(1000);
    fails.collections = [409, RAW];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fireEvent.change(select()!, { target: { value: '__new__' } });
    await tick(10);
    fireEvent.change(screen.getByRole('textbox', { name: /New collection name/ }), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await tick(2000);
    expect(posts.some((p) => p.endsWith('/collections'))).toBe(true);
    expect(commonsLines()).toEqual(['Nebula couldn’t load the collections because the server didn’t accept it. Try again.']);
    expect(document.querySelector('[data-commons-line]')!.hasAttribute('data-line-neutral')).toBe(true);
    expect(seen).not.toContain('Couldn’t update the library');
    expect(seen).not.toContain('ZZRAW');
    warn.mockRestore();
  });
});

describe('one loading look (GM r32 5, live NIT-2)', () => {
  const expectLoading = async (words: string) => {
    await tick(250);
    expect(text()).not.toContain(words);
    await tick(100);
    const line = screen.getByText(words);
    expect(line.className).toBe('commons-loading');
    expect(line.hasAttribute('data-line-box')).toBe(false);
    expect(line.closest('.commons-notice')).toBeNull();
    return line;
  };
  it('Agent review: "Loading agent reviews…", only after 300 ms', async () => {
    held.review = new Promise(() => {});
    render(<CommonsReview />);
    await expectLoading('Loading agent reviews…');
  });
  it('Settings: its heading, the line under it', async () => {
    held.folders = new Promise(() => {});
    render(<CommonsSettings status={null} onOpenAsset={() => {}} onChanged={() => {}} />);
    const line = await expectLoading('Loading settings…');
    expect(line.previousElementSibling?.textContent).toBe('Settings');
  });
  it('a reference\'s detail: "Loading details…"', async () => {
    transport.fetch.mockImplementation(async (path: string, init?: RequestInit) => (
      path.includes('/assets/') ? new Promise(() => {}) : answer(path, init)));
    render(<CommonsDetail assetId="a1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
    await expectLoading('Loading details…');
  });
  it('a load quicker than 300 ms shows no loading line at all', async () => {
    render(<CommonsReview />);
    await tick(1000);
    expect(seen).not.toContain('Loading agent reviews…');
  });
});

describe('a pane\'s load line hides beside "Nebula is offline" (live LOW-1)', () => {
  it('Agent review: the line goes offline and comes back online', async () => {
    fails.review = [500];
    render(<CommonsReview />);
    await tick(1000);
    expect(commonsLines()).toEqual(['Nebula couldn’t load Agent review because the server hit an error. Try again.']);
    act(() => noteBackendConnection('offline'));
    fails.review = [0];
    transport.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/review')) throw new TypeError('Failed to fetch');
      return answer(path, init);
    });
    await tick(6000);
    expect(commonsLines()).toEqual([]);
    expect(seen).not.toContain('isn’t answering');
  });
  it('Settings: the same', async () => {
    fails.folders = [500];
    render(<CommonsSettings status={null} onOpenAsset={() => {}} onChanged={() => {}} />);
    await tick(1000);
    expect(commonsLines()).toHaveLength(1);
    act(() => noteBackendConnection('offline'));
    await tick(100);
    expect(commonsLines()).toEqual([]);
    act(() => noteBackendConnection('online'));
    await tick(100);
    expect(commonsLines()).toHaveLength(1);
  });
});

describe('Agent review back from another section (review 14 NIT-1, X13)', () => {
  it('a failed load, away, then back: the read on return answers and the setup state shows at once', async () => {
    fails.review = [503];
    const view = render(<CommonsReview active />);
    await tick(1000);
    expect(text()).not.toContain('Prepare the reference set in Blind labeling first.');
    view.rerender(<CommonsReview active={false} />);
    await tick(100);
    delete fails.review;
    view.rerender(<CommonsReview active />);
    // Well before the next poll (5 s).
    await tick(200);
    expect(text()).toContain('Prepare the reference set in Blind labeling first.');
  });
});

describe('which lines are a load\'s (review 14 NIT-1, X4 and X6)', () => {
  it('only a line that starts as a load\'s: an action line naming a load later is not one', () => {
    expect(isLoadLine('Couldn’t save the settings. Nebula couldn’t load the list.')).toBe(false);
    expect(isLoadLine('Couldn’t save the settings. Saved. Nebula couldn’t load the settings back because x. Reload to see them.')).toBe(false);
    expect(isLoadLine(savedReadBackLine('the server didn’t respond'))).toBe(true);
  });
  it('an action\'s because line is neutral too (it is a because line, not a load\'s)', () => {
    const line = notConnectedBecause('save the settings', false);
    expect(isLoadLine(line)).toBe(false);
    render(<CommonsErrorLine line={line} />);
    const box = document.querySelector('[data-commons-line]')!;
    expect(box.hasAttribute('data-line-neutral')).toBe(true);
    expect(lineLook(box)).toEqual(NEUTRAL);
  });
});

describe('the bare-lines ratchet lets GM r31\'s two names, and only on a locked control', () => {
  it('flags them anywhere else, and any other "connected as you" name', async () => {
    const { bareLinesIn } = await import('./helpers/bareLines');
    const { ADD_NOT_CONNECTED, ADD_TO_NOT_CONNECTED } = await import('../src/lib/commonsAddCopy');
    const root = document.createElement('div');
    root.innerHTML = `<button aria-label="${ADD_NOT_CONNECTED}" data-person-lock="add references">Add</button>`
      + `<select aria-label="${ADD_TO_NOT_CONNECTED}" data-person-lock="add references"></select>`;
    expect(bareLinesIn(root)).toEqual([]);
    root.innerHTML = `<button aria-label="${ADD_NOT_CONNECTED}">Add</button>`
      + '<button aria-label="Save, when this tab is connected as you." data-person-lock="save">Save</button>';
    expect(bareLinesIn(root)).toHaveLength(2);
  });
});
