import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyAssetStudioEntry, useAssetStudioDraftStore, type AssetStudioDraftEntry } from '../../store/assetStudioDraftStore';
import type { MoodboardOp } from '../../lib/moodboardEdits';
import { dropKeptEdit, isUnsavedBoardKey, keepUnsavedDrafts, keptEditOf, keptEditsWaiting, replayKeptFields, resetUnsavedDrafts,
  restoreUnsavedDrafts, takeKeptEdit, unsavedWouldBeLost, type KeptEdit } from './unsavedDrafts';
import { takeWaitingSend } from './boardAdds';

// Round 6g (GM r15 3): an unsaved board's draft lives through a reload of
// its tab, in session storage, as the waiting sends do.
const KEY = 'nebula:moodboard-unsaved-drafts';
const newKey = JSON.stringify(['moodboard', 'global', 'new']);
const river = '/api/outputs/chat-uploads/river.png';
const LINE = { heading: '', reason: 'Nebula couldn’t save the board because the server hit an error. Try again.' };

const card = (id: string) => [{ id: `c-${id}`, frameId: null, x: 0, y: 0, w: 480, h: 270, weight: 1, placedBy: 'person', placedAt: '' }];
const img = (id: string, url: string) => ({ id, url, weight: 1, notes: '', privateNote: '', excluded: false, placements: card(id) });
const addOp = (id: string, url: string): MoodboardOp => ({ op: 'add', images: [{ id, url }], at: { x: 0, y: 0 } } as MoodboardOp);

/** An unsaved board whose create failed: two images (one only this page holds), an add queued for each, one attempt sent. */
function failedUnsaved(): AssetStudioDraftEntry {
  const riverAdd = addOp('i1', river);
  const blobAdd = addOp('i2', 'blob:http://localhost/123');
  const draft = { name: 'Rivers', notes: '', mode: 'look', strength: 0.7, images: [img('i1', river), img('i2', 'blob:http://localhost/123')],
    pendingOps: [riverAdd, blobAdd] };
  return { ...emptyAssetStudioEntry(draft), loaded: true, dirty: true, saveState: 'error', saveError: LINE, retry: 'save',
    createRequestId: 'req-12345678', createAttempts: [{ n: 1, sent: [riverAdd, blobAdd], asSent: { name: 'Rivers' } }],
    fieldEditedAt: { name: 5 } };
}

const EDITS = 'nebula:moodboard-kept-edits';
const kept = () => JSON.parse(window.sessionStorage.getItem(KEY) ?? '[]') as Array<Record<string, unknown> & { draft: { images: Array<{ url: string }>; pendingOps: MoodboardOp[] } }>;
const set = (entries: Record<string, AssetStudioDraftEntry>) => useAssetStudioDraftStore.setState({ entries, aliases: {} });

// What the last page load of this tab left, put back when the page installs the keeping (round 6g).
const LEFT = JSON.stringify(['moodboard', 'project', 'p9', 'new']);
let atInstall: AssetStudioDraftEntry | undefined;
beforeAll(() => {
  window.sessionStorage.setItem(KEY, JSON.stringify([{ key: LEFT, draft: { name: 'Left', images: [img('i7', river)], pendingOps: [] },
    createRequestId: 'req-left-0001', attempts: [], saveError: LINE, retry: 'save', failed: true, at: Date.now() }]));
  keepUnsavedDrafts();
  atInstall = useAssetStudioDraftStore.getState().entries[LEFT];
});
beforeEach(() => {
  set({});
  window.sessionStorage.removeItem(KEY);
  window.sessionStorage.removeItem(EDITS);
  resetUnsavedDrafts();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the unsaved board kept for a reload', () => {
  it('is put back when the page installs the keeping, before anything renders', () => {
    expect(atInstall).toMatchObject({ loaded: true, dirty: true, saveState: 'error', saveError: LINE, createRequestId: 'req-left-0001' });
    expect((atInstall!.draft as { name: string }).name).toBe('Left');
  });

  it('knows an unsaved board\'s key', () => {
    expect(isUnsavedBoardKey(newKey)).toBe(true);
    expect(isUnsavedBoardKey(JSON.stringify(['moodboard', 'project', 'new', 'p1']))).toBe(false);
    expect(isUnsavedBoardKey(JSON.stringify(['moodboard', 'project', 'p1', 'new']))).toBe(true);
    expect(isUnsavedBoardKey(JSON.stringify(['moodboard', 'global', 'g1']))).toBe(false);
    expect(isUnsavedBoardKey(JSON.stringify(['style', 'global', 'new']))).toBe(false);
    expect(isUnsavedBoardKey('not json')).toBe(false);
  });

  it('writes its draft: the images a reload can show, their adds, its line, Retry, id and attempts', () => {
    set({ [newKey]: failedUnsaved() });
    const [entry] = kept();
    expect(entry).toMatchObject({ key: newKey, createRequestId: 'req-12345678', saveError: LINE, retry: 'save', failed: true,
      fieldEditedAt: { name: 5 } });
    // The blob: image only this page held can't be kept, nor its add.
    expect(entry.draft.images.map((image) => image.url)).toEqual([river]);
    expect(entry.draft.pendingOps).toEqual([addOp('i1', river)]);
    expect(entry.attempts).toEqual([{ n: 1, sent: [0], asSent: { name: 'Rivers' } }]);
  });

  it('puts it back on the next page load, as it was: the error look, its line and Retry, its id and attempts', () => {
    set({ [newKey]: failedUnsaved() });
    const stored = window.sessionStorage.getItem(KEY);
    // The page that reloads holds nothing yet; its storage holds what the last one wrote.
    set({});
    window.sessionStorage.setItem(KEY, stored!);
    restoreUnsavedDrafts();
    const entry = useAssetStudioDraftStore.getState().entries[newKey];
    expect(entry).toMatchObject({ loaded: true, dirty: true, saveState: 'error', saveError: LINE, retry: 'save',
      createRequestId: 'req-12345678', fieldEditedAt: { name: 5 }, savedId: null, pendingSaveId: null });
    const draft = entry.draft as { name: string; images: Array<{ url: string }>; pendingOps: MoodboardOp[] };
    expect(draft.name).toBe('Rivers');
    expect(draft.images.map((image) => image.url)).toEqual([river]);
    // An attempt's sent ops are the draft's own ops again (the rebase compares them by identity).
    expect(entry.createAttempts).toHaveLength(1);
    expect(entry.createAttempts![0].sent[0]).toBe(draft.pendingOps[0]);
  });

  it('a board waiting (not failed) comes back as a draft to send: no line, no Retry', () => {
    set({ [newKey]: { ...failedUnsaved(), saveState: 'draft', saveError: null, retry: null } });
    const stored = window.sessionStorage.getItem(KEY)!;
    set({});
    window.sessionStorage.setItem(KEY, stored);
    restoreUnsavedDrafts();
    expect(useAssetStudioDraftStore.getState().entries[newKey]).toMatchObject({ saveState: 'draft', saveError: null, retry: null, dirty: true });
  });

  it('never puts one over a draft loaded at its key', () => {
    set({ [newKey]: failedUnsaved() });
    const stored = window.sessionStorage.getItem(KEY)!;
    const fresh = { ...emptyAssetStudioEntry({ name: 'Fresh', images: [] }), loaded: true };
    set({ [newKey]: fresh });
    window.sessionStorage.setItem(KEY, stored);
    restoreUnsavedDrafts();
    expect((useAssetStudioDraftStore.getState().entries[newKey].draft as { name: string }).name).toBe('Fresh');
  });

  it('goes once the board is saved, emptied or gone', () => {
    set({ [newKey]: failedUnsaved() });
    expect(kept()).toHaveLength(1);
    useAssetStudioDraftStore.getState().patch(newKey, { savedId: 'made1' });
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    set({ [newKey]: failedUnsaved() });
    expect(kept()).toHaveLength(1);
    useAssetStudioDraftStore.getState().edit(newKey, (draft) => ({ ...(draft as object), images: [] }));
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    set({ [newKey]: failedUnsaved() });
    set({});
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('keeps nothing for a saved board or a draft not loaded', () => {
    set({ [JSON.stringify(['moodboard', 'global', 'g1'])]: { ...failedUnsaved(), savedId: 'g1' } });
    set({ [newKey]: { ...failedUnsaved(), loaded: false } });
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it.each([
    ['not JSON', () => '{'],
    ['not a list', () => JSON.stringify({ key: newKey })],
    ['a day old', (entry: Record<string, unknown>) => JSON.stringify([{ ...entry, at: Date.now() - 24 * 60 * 60 * 1000 - 1 }])],
    ['not an unsaved board\'s key', (entry: Record<string, unknown>) => JSON.stringify([{ ...entry, key: JSON.stringify(['moodboard', 'global', 'g1']) }])],
    ['an image only that page held', (entry: Record<string, unknown> & { draft: object }) => JSON.stringify([{ ...entry,
      draft: { ...entry.draft, images: [img('i9', 'blob:http://localhost/9')] } }])],
    ['an op of no known shape', (entry: Record<string, unknown> & { draft: object }) => JSON.stringify([{ ...entry,
      draft: { ...entry.draft, pendingOps: [{ op: 'explode' }] } }])],
    ['an attempt with no number', (entry: Record<string, unknown>) => JSON.stringify([{ ...entry, attempts: [{ sent: [], asSent: {} }] }])],
    ['a line of no known shape', (entry: Record<string, unknown>) => JSON.stringify([{ ...entry, saveError: 5 }])],
    ['an id of no known shape', (entry: Record<string, unknown>) => JSON.stringify([{ ...entry, createRequestId: 7 }])],
  ] as const)('ignores an entry that is %s', (_name, spoil) => {
    set({ [newKey]: failedUnsaved() });
    const [entry] = kept();
    set({});
    window.sessionStorage.setItem(KEY, (spoil as (entry: Record<string, unknown> & { draft: object }) => string)(entry));
    restoreUnsavedDrafts();
    expect(useAssetStudioDraftStore.getState().entries[newKey]).toBeUndefined();
    expect(Object.keys(useAssetStudioDraftStore.getState().entries)).toEqual([]);
  });

  it('keeps another tab-load\'s entry for another key it doesn\'t hold', () => {
    const otherKey = JSON.stringify(['moodboard', 'project', 'p1', 'new']);
    set({ [otherKey]: failedUnsaved() });
    const stored = window.sessionStorage.getItem(KEY)!;
    set({});
    window.sessionStorage.setItem(KEY, stored);
    resetUnsavedDrafts();
    set({ [newKey]: failedUnsaved() });
    expect(kept().map((entry) => entry.key).sort()).toEqual([newKey, otherKey].sort());
  });
});

describe('the warning before unload', () => {
  const unload = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('stays quiet while the draft is kept', () => {
    set({ [newKey]: failedUnsaved() });
    expect(kept()).toHaveLength(1);
    expect(unsavedWouldBeLost()).toBe(false);
    expect(unload()).toBe(false);
  });

  it('asks only when the write failed (storage full or blocked), and stops asking once a write works', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    set({ [newKey]: failedUnsaved() });
    expect(unsavedWouldBeLost()).toBe(true);
    expect(unload()).toBe(true);
    setItem.mockRestore();
    useAssetStudioDraftStore.getState().edit(newKey, (draft) => ({ ...(draft as object), name: 'Rivers 2' }));
    expect(kept()).toHaveLength(1);
    expect(unsavedWouldBeLost()).toBe(false);
    expect(unload()).toBe(false);
  });

  it('a failed write with no unsaved board open asks nothing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    set({ [newKey]: failedUnsaved() });
    vi.restoreAllMocks();
    set({});
    expect(unload()).toBe(false);
  });

  it('storage that throws on read keeps nothing and breaks nothing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    expect(() => restoreUnsavedDrafts()).not.toThrow();
    expect(() => set({ [newKey]: failedUnsaved() })).not.toThrow();
  });
});

// Round 6i (GM r17 2+3): a saved board's kept edit lives through a reload too.
describe('a saved board\'s kept edit', () => {
  const g1Key = JSON.stringify(['moodboard', 'global', 'g1']);
  const base = { name: 'Global board', notes: '', mode: 'look', strength: 0.7 };
  const edits = () => JSON.parse(window.sessionStorage.getItem(EDITS) ?? '[]') as KeptEdit[];
  /** g1 loaded, with `draft` over what it last read. */
  const saved = (draft: Record<string, unknown> = {}, entry: Partial<AssetStudioDraftEntry> = {}): AssetStudioDraftEntry => ({
    ...emptyAssetStudioEntry({ ...base, images: [img('i1', river)], base, version: 3, pendingOps: [], ...draft }),
    savedId: 'g1', loaded: true, dirty: true, fieldEditedAt: { name: 7 }, ...entry });

  it('is what the draft holds that the server doesn\'t: changed fields with what they were, storable ops, edit times', () => {
    const add = addOp('i9', '/api/outputs/chat-uploads/sea.png');
    const edit = keptEditOf(g1Key, saved({ name: 'Dusk', pendingOps: [add, addOp('i8', 'blob:http://localhost/1')] }))!;
    expect(edit).toMatchObject({ board: 'g1', fields: { name: 'Dusk' }, base: { name: 'Global board' }, fieldEditedAt: { name: 7 }, ops: [add] });
    // The board's saved name, trimmed, to name the board if it's gone (round 6j): not the rename that never saved;
    // the draft's when the board has none; none when both are blank.
    expect(keptEditOf(g1Key, saved({ name: '  Dusk ' }))?.name).toBe('Global board');
    expect(keptEditOf(g1Key, saved({ name: '  Dusk ', base: { ...base, name: '  ' } }))?.name).toBe('Dusk');
    expect(keptEditOf(g1Key, saved({ name: '  ', notes: 'x', base: { ...base, name: ' ' } }))).not.toHaveProperty('name');
  });

  it('those an earlier page load left wait, listed for the Studio to look up; this page\'s own don\'t (round 6j)', () => {
    const left = (board: string, extra: Record<string, unknown> = {}) => ({ board, name: board.toUpperCase(), fields: { name: 'X' }, base: {}, ops: [], at: Date.now(), ...extra });
    window.sessionStorage.setItem(EDITS, JSON.stringify([left('g1'), left('g2'), left('g3', { name: 5 })]));
    expect(keptEditsWaiting().map((it) => [it.board, it.name])).toEqual([['g1', 'G1'], ['g2', 'G2']]);
    // This page writes its own for g1: that one isn't waiting.
    set({ [g1Key]: saved({ name: 'Dusk' }) });
    expect(keptEditsWaiting().map((it) => it.board)).toEqual(['g2']);
    // Dropped: g2's goes; this page's own g1 stays, whoever asks.
    dropKeptEdit('g2');
    dropKeptEdit('g1');
    dropKeptEdit('g9');
    expect(edits().map((it) => it.board)).toEqual(['g1']);
    expect(keptEditsWaiting()).toEqual([]);
  });

  it('dropping the last waiting edit clears the store, and dropping one not there writes nothing', () => {
    window.sessionStorage.setItem(EDITS, JSON.stringify([{ board: 'g2', fields: { name: 'X' }, base: {}, ops: [], at: Date.now() }]));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    dropKeptEdit('g9');
    expect(setItem).not.toHaveBeenCalled();
    dropKeptEdit('g2');
    expect(window.sessionStorage.getItem(EDITS)).toBeNull();
  });

  it('is nothing for a clean board, a name changed only by spaces, a draft not loaded or not saved, or an unsaved key', () => {
    expect(keptEditOf(g1Key, saved())).toBeNull();
    expect(keptEditOf(g1Key, saved({ name: ' Global board ' }))).toBeNull();
    expect(keptEditOf(g1Key, saved({ name: 'Dusk' }, { loaded: false }))).toBeNull();
    expect(keptEditOf(g1Key, saved({ name: 'Dusk' }, { savedId: null }))).toBeNull();
    expect(keptEditOf(newKey, saved({ name: 'Dusk' }))).toBeNull();
    expect(keptEditOf(JSON.stringify(['character', 'global', 'c1']), saved({ name: 'Dusk' }))).toBeNull();
    expect(keptEditOf(g1Key, undefined)).toBeNull();
  });

  it('is written while it holds something and goes once the board has it all', () => {
    set({ [g1Key]: saved({ name: 'Dusk' }) });
    expect(edits()).toEqual([expect.objectContaining({ board: 'g1', fields: { name: 'Dusk' } })]);
    // Saved: the draft read the board again, nothing unsent.
    set({ [g1Key]: saved({ name: 'Dusk', base: { ...base, name: 'Dusk' } }, { dirty: false }) });
    expect(window.sessionStorage.getItem(EDITS)).toBeNull();
  });

  it('an earlier page load\'s edit waits for its board\'s load, which takes it once; this page\'s own is never taken', () => {
    set({ [g1Key]: saved({ name: 'Dusk' }) });
    const stored = window.sessionStorage.getItem(EDITS)!;
    // The reload: a new page with an empty store.
    resetUnsavedDrafts();
    set({});
    window.sessionStorage.setItem(EDITS, stored);
    // The board's draft starts loading (not loaded yet): the edit stays.
    set({ [g1Key]: { ...emptyAssetStudioEntry({}), savedId: null } });
    expect(edits()).toHaveLength(1);
    expect(takeKeptEdit('g2')).toBeNull();
    expect(takeKeptEdit('g1')).toMatchObject({ board: 'g1', fields: { name: 'Dusk' } });
    expect(takeKeptEdit('g1')).toBeNull();
    expect(window.sessionStorage.getItem(EDITS)).toBeNull();
    // Another board's edit written here leaves an earlier page load's edit for g1 alone.
    window.sessionStorage.setItem(EDITS, stored);
    const g2Key = JSON.stringify(['moodboard', 'global', 'g2']);
    set({ [g2Key]: saved({ name: 'Other' }, { savedId: 'g2' }) });
    expect(edits().map((it) => it.board).sort()).toEqual(['g1', 'g2']);
    set({});
    window.sessionStorage.removeItem(EDITS);
    resetUnsavedDrafts();
    // This page's own: not taken (its draft has it).
    set({ [g1Key]: saved({ name: 'Dusk' }) });
    expect(takeKeptEdit('g1')).toBeNull();
    expect(edits()).toHaveLength(1);
  });

  it('an earlier page load\'s edit for a board loaded here without it gives way to this page\'s own', () => {
    window.sessionStorage.setItem(EDITS, JSON.stringify([{ board: 'g1', fields: { name: 'Dusk' }, base: { name: 'Global board' }, ops: [], at: Date.now() }]));
    set({ [g1Key]: saved() });
    set({ [g1Key]: saved({ notes: 'mine' }) });
    expect(edits()).toEqual([expect.objectContaining({ board: 'g1', fields: { notes: 'mine' } })]);
    set({ [g1Key]: saved({ notes: 'mine', base: { ...base, notes: 'mine' } }, { dirty: false }) });
    expect(window.sessionStorage.getItem(EDITS)).toBeNull();
  });

  it('drops a stored edit not shaped as one', () => {
    const good = { board: 'g1', fields: { name: 'Dusk' }, base: {}, ops: [], at: Date.now() };
    for (const bad of [{ ...good, board: 5 }, { ...good, fields: { evil: 1 } }, { ...good, at: 'now' },
      { ...good, ops: [{ op: 'nope' }] }, { ...good, fieldEditedAt: { name: 'x' } }, { ...good, base: null },
      // Round 6l: each op's meta, by index.
      { ...good, opMeta: [null] }, { ...good, opMeta: 'x' },
      { ...good, ops: [{ op: 'weight', image: 'i1', value: 0.2 }], opMeta: [{ at: 'then' }] },
      { ...good, ops: [{ op: 'restore', slices: [] }], opMeta: [{ at: 1, version: 'v3' }] }]) {
      window.sessionStorage.setItem(EDITS, JSON.stringify([bad]));
      expect(takeKeptEdit('g1')).toBeNull();
    }
    window.sessionStorage.setItem(EDITS, JSON.stringify([{ ...good, ops: [{ op: 'weight', image: 'i1', value: 0.2 }], opMeta: [null] }]));
    expect(takeKeptEdit('g1')).toMatchObject({ opMeta: [null] });
  });

  // Round 6l (GM r21 expiry): a kept edit lives as long as its board, or its project, can be restored.
  it('keeps an edit of any age, and every board\'s, with no cap', () => {
    const old = { board: 'g1', fields: { name: 'Dusk' }, base: {}, ops: [], at: Date.now() - 30 * 24 * 60 * 60 * 1000 };
    window.sessionStorage.setItem(EDITS, JSON.stringify([old]));
    expect(keptEditsWaiting().map((it) => it.board)).toEqual(['g1']);
    expect(takeKeptEdit('g1')).toMatchObject({ board: 'g1', fields: { name: 'Dusk' } });
    // Twelve boards' edits, held by this page: all twelve kept (the cap of ten would have dropped the oldest two silently).
    const entries = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [JSON.stringify(['moodboard', 'global', `b${index}`]),
      saved({ name: `Dusk ${index}` }, { savedId: `b${index}` })]));
    set(entries);
    expect(edits().map((it) => it.board)).toEqual(Array.from({ length: 12 }, (_, index) => `b${index}`));
    expect(unsavedWouldBeLost()).toBe(false);
  });

  // Round 6m (GM r53 Q2): a waiting send (boardAdds.ts) lives as long as its board's kept edit, not a fixed day.
  it('a waiting send older than a day stays while its board holds a kept edit; with none, it ages out', () => {
    const WAITING = 'nebula:moodboard-sends-waiting';
    const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const send = (board: string) => ({ board, ops: [{ op: 'weight', image: 'i1', value: 0.5 }], fields: {}, page: 'before', at: old });
    window.sessionStorage.setItem(WAITING, JSON.stringify([send('t1'), send('t2')]));
    window.sessionStorage.setItem(EDITS, JSON.stringify([{ board: 't1', fields: { name: 'Dusk' }, base: {}, ops: [], at: old }]));
    // t1's send is kept (its board's kept edit lives on); t2's has nothing behind it, so a day ends it.
    expect(takeWaitingSend('t2')).toBeNull();
    expect(takeWaitingSend('t1')).toEqual({ ops: [{ op: 'weight', image: 'i1', value: 0.5 }], fields: {} });
    // Held in a draft here counts too: the kept edit this page writes.
    window.sessionStorage.removeItem(EDITS);
    window.sessionStorage.setItem(WAITING, JSON.stringify([send('b1')]));
    set({ [JSON.stringify(['moodboard', 'global', 'b1'])]: saved({ name: 'Dusk' }, { savedId: 'b1' }) });
    expect(edits().map((it) => it.board)).toEqual(['b1']);
    expect(takeWaitingSend('b1')).not.toBeNull();
    // Once the kept edit goes (its board deleted for good, and said), the send ages out again.
    set({});
    window.sessionStorage.setItem(WAITING, JSON.stringify([send('t1')]));
    window.sessionStorage.setItem(EDITS, JSON.stringify([{ board: 't1', fields: { name: 'Dusk' }, base: {}, ops: [], at: old }]));
    dropKeptEdit('t1');
    expect(takeWaitingSend('t1')).toBeNull();
    window.sessionStorage.removeItem(WAITING);
  });

  // Round 6l (review 10 MEDIUM-1, GM r21 Q1): each queued image change keeps when it was made and what it changed from.
  it('records each op\'s time and the value it changed from; a later op on the same thing keeps the first from-value', () => {
    vi.useFakeTimers({ now: 1_000, toFake: ['Date'] });
    try {
      set({ [g1Key]: saved() });
      const first = { op: 'weight', image: 'i1', value: 0.2 } as MoodboardOp;
      const draftOf = () => useAssetStudioDraftStore.getState().entries[g1Key].draft as Record<string, unknown> & { images: Array<Record<string, unknown>> };
      useAssetStudioDraftStore.getState().edit(g1Key, (draft) => ({ ...(draft as object), images: [{ ...img('i1', river), weight: 0.2 }], pendingOps: [first] }));
      vi.setSystemTime(2_000);
      const second = { op: 'weight', image: 'i1', value: 0.3 } as MoodboardOp;
      const aside = { op: 'setAside', image: 'i1', value: true } as MoodboardOp;
      const note = { op: 'note', image: 'i1', privateNote: 'liked' } as MoodboardOp;
      const place = { op: 'place', placement: 'c-i1', x: 40, y: 50 } as MoodboardOp;
      const cover = { op: 'cover', image: 'i1' } as MoodboardOp;
      const undo = { op: 'restore', slices: [{ image: 'i1' }] } as MoodboardOp;
      useAssetStudioDraftStore.getState().edit(g1Key, (draft) => ({ ...(draft as object), coverImageId: null,
        images: [{ ...draftOf().images[0], weight: 0.3, excluded: true, privateNote: 'liked' }], pendingOps: [first, second, aside, note, place, cover, undo] }));
      const [stored] = edits();
      expect(stored.ops).toHaveLength(7);
      expect(stored.opMeta).toEqual([
        { at: 1_000, from: 1 },
        { at: 2_000, from: 1 },
        { at: 2_000, from: false },
        { at: 2_000, from: { privateNote: '' } },
        { at: 2_000, from: { x: 0, y: 0 } },
        { at: 2_000, from: null },
        { at: 2_000, version: 3 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an op the queue replaced (a slider\'s second step) hands its from-value on: the board\'s, not the first step\'s (live 6l)', () => {
    set({ [g1Key]: saved() });
    const step = (value: number) => {
      const op = { op: 'weight', image: 'i1', value } as MoodboardOp;
      useAssetStudioDraftStore.getState().edit(g1Key, (draft) => ({ ...(draft as object), images: [{ ...img('i1', river), weight: value }],
        pendingOps: [...((draft as { pendingOps?: MoodboardOp[] }).pendingOps ?? []).filter((it) => it.op !== 'weight'), op] }));
    };
    step(0.95);
    step(0.9);
    const [stored] = edits();
    expect(stored.ops).toEqual([{ op: 'weight', image: 'i1', value: 0.9 }]);
    expect(stored.opMeta).toEqual([expect.objectContaining({ from: 1 })]);
  });

  it('asks before unload only when its write failed', () => {
    set({ [g1Key]: saved({ name: 'Dusk' }) });
    expect(unsavedWouldBeLost()).toBe(false);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    useAssetStudioDraftStore.getState().patch(g1Key, { draft: { ...(useAssetStudioDraftStore.getState().entries[g1Key].draft as object), name: 'Dusk 2' } });
    expect(unsavedWouldBeLost()).toBe(true);
    setItem.mockRestore();
    useAssetStudioDraftStore.getState().patch(g1Key, { draft: { ...(useAssetStudioDraftStore.getState().entries[g1Key].draft as object), name: 'Dusk 3' } });
    expect(unsavedWouldBeLost()).toBe(false);
  });
});

describe('replaying a kept edit on the board as it is now (the 6g rule)', () => {
  const edit = (fields: Record<string, unknown>, from: Record<string, unknown>, at: Record<string, number> = {}): KeptEdit =>
    ({ board: 'g1', fields, base: from, fieldEditedAt: at, ops: [], at: 0 });

  it('a field the board didn\'t change since takes the edit\'s value', () => {
    expect(replayKeptFields(edit({ name: 'Dusk' }, { name: 'Global' }, { name: 1 }), { name: 'Global' }, 99)).toEqual({ fields: { name: 'Dusk' }, kept: [] });
  });

  it('a field both changed goes to the later edit, and the board\'s win is named', () => {
    expect(replayKeptFields(edit({ name: 'Dusk' }, { name: 'Global' }, { name: 50 }), { name: 'Rivers' }, 99)).toEqual({ fields: {}, kept: ['name'] });
    expect(replayKeptFields(edit({ name: 'Dusk' }, { name: 'Global' }, { name: 150 }), { name: 'Rivers' }, 99)).toEqual({ fields: { name: 'Dusk' }, kept: [] });
    // No edit time: the board's.
    expect(replayKeptFields(edit({ notes: 'a' }, { notes: '' }), { notes: 'b' }, 1)).toEqual({ fields: {}, kept: ['notes'] });
  });

  it('a field the board already holds as the edit has it is left alone', () => {
    expect(replayKeptFields(edit({ name: 'Dusk', mode: 'style' }, { name: 'Global', mode: 'look' }, { name: 1, mode: 1 }), { name: ' Dusk ', mode: 'style' }, 99))
      .toEqual({ fields: {}, kept: [] });
  });

  it('every field older than the board\'s change: all the board\'s, all named', () => {
    expect(replayKeptFields(edit({ name: 'Dusk', notes: 'n', mode: 'style', strength: 0.2 }, { name: 'G', notes: '', mode: 'look', strength: 0.7 },
      { name: 1, notes: 1, mode: 1, strength: 1 }), { name: 'R', notes: 'm', mode: 'brand', strength: 0.5 }, 9)).toEqual({ fields: {}, kept: ['name', 'notes', 'mode', 'strength'] });
  });
});
