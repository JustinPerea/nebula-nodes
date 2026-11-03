import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyAssetStudioEntry, useAssetStudioDraftStore, type AssetStudioDraftEntry } from '../../store/assetStudioDraftStore';
import type { MoodboardOp } from '../../lib/moodboardEdits';
import { isUnsavedBoardKey, keepUnsavedDrafts, resetUnsavedDrafts, restoreUnsavedDrafts, unsavedWouldBeLost } from './unsavedDrafts';

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
