import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => [] as Array<(event: unknown) => void>);
vi.mock('../lib/wsClient', () => ({ wsClient: { subscribe: (handler: (event: unknown) => void) => {
  handlers.push(handler); return () => {}; } } }));
const api = vi.hoisted(() => ({ fetchMoodboard: vi.fn(), fetchCharacter: vi.fn() }));
vi.mock('../lib/api', () => api);

import { assetStudioDraftKey, emptyAssetStudioEntry, resolveAssetStudioDraftKey,
  useAssetStudioDraftStore } from './assetStudioDraftStore';
import { followAssetMoves } from '../lib/keptDraftMoves';

const entry = (draft: object, extra = {}) => ({ ...emptyAssetStudioEntry(draft), savedId: 'b1', loaded: true, ...extra });

beforeEach(() => {
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  api.fetchMoodboard.mockReset();
  api.fetchCharacter.mockReset();
});

describe('kept Studio drafts follow a move', () => {
  it('Global to a project: the draft takes the projectId and the project key; edits and the old key (alias) stay', () => {
    const global = assetStudioDraftKey('moodboard', 'global', 'b1');
    useAssetStudioDraftStore.setState({ entries: { [global]: entry({ name: 'Edited' }, { dirty: true, revision: 3 }) } });

    useAssetStudioDraftStore.getState().rehome('moodboard', 'b1', 'pA');

    const state = useAssetStudioDraftStore.getState();
    const project = assetStudioDraftKey('moodboard', 'project', 'b1', 'pA');
    expect(state.entries[project]).toMatchObject({ draft: { name: 'Edited', projectId: 'pA' }, dirty: true, revision: 3 });
    expect(resolveAssetStudioDraftKey(state, global)).toBe(project);
  });

  it('moved there and back: both keys still lead to the one draft, with its edits', () => {
    const global = assetStudioDraftKey('character', 'global', 'c1');
    const project = assetStudioDraftKey('character', 'project', 'c1', 'pA');
    useAssetStudioDraftStore.setState({ entries: { [global]: { ...entry({ name: 'Edited' }, { dirty: true, revision: 2 }),
      savedId: 'c1' } } });
    const store = () => useAssetStudioDraftStore.getState();

    store().rehome('character', 'c1', 'pA');
    store().rehome('character', 'c1', null);

    expect(Object.keys(store().entries)).toEqual([global]);
    expect(resolveAssetStudioDraftKey(store(), project)).toBe(global);
    expect(resolveAssetStudioDraftKey(store(), global)).toBe(global);
    expect(store().entries[global]).toMatchObject({ draft: { name: 'Edited', projectId: undefined }, dirty: true,
      loaded: true, revision: 2 });

    store().rehome('character', 'c1', 'pA');
    expect(Object.keys(store().entries)).toEqual([project]);
    expect(resolveAssetStudioDraftKey(store(), global)).toBe(project);
    expect(resolveAssetStudioDraftKey(store(), project)).toBe(project);
    expect(store().entries[project]).toMatchObject({ draft: { name: 'Edited', projectId: 'pA' }, dirty: true });
  });

  it('a project draft seen from another project (key stays) only takes the new projectId; others are left alone', () => {
    const fromB = assetStudioDraftKey('moodboard', 'project', 'b1', 'pB');
    const other = assetStudioDraftKey('moodboard', 'global', 'b2');
    const character = assetStudioDraftKey('character', 'global', 'b1');
    useAssetStudioDraftStore.setState({ entries: { [fromB]: entry({ projectId: 'pA' }), [other]: entry({}),
      [character]: entry({}) } });

    useAssetStudioDraftStore.getState().rehome('moodboard', 'b1', 'pB');

    const state = useAssetStudioDraftStore.getState();
    expect(state.entries[fromB].draft).toEqual({ projectId: 'pB' });
    expect(state.entries[other].draft).toEqual({});
    expect(state.entries[character].draft).toEqual({});
  });

  it('a move broadcast (storedAssetChanged with projectId) re-homes; other changes do not', () => {
    const project = assetStudioDraftKey('character', 'project', 'c1', 'pA');
    useAssetStudioDraftStore.setState({ entries: { [project]: { ...entry({ projectId: 'pA' }), savedId: 'c1' } } });
    followAssetMoves();
    followAssetMoves(); // once per session
    expect(handlers).toHaveLength(1);

    handlers[0]({ type: 'storedAssetChanged', kind: 'character', id: 'c1', deleted: false });
    expect(useAssetStudioDraftStore.getState().entries[project]).toBeTruthy();
    handlers[0]({ type: 'storedAssetChanged', kind: 'character', id: 'c1', deleted: false, projectId: null });
    const global = assetStudioDraftKey('character', 'global', 'c1');
    expect(useAssetStudioDraftStore.getState().entries[global]?.draft).toEqual({ projectId: undefined });
  });
});

describe('kept Studio drafts after the socket comes back', () => {
  // A move made while this tab's socket was down isn't replayed (wsClient
  // socketReconnected), so each kept draft reads where its asset lives now.
  const listen = () => { followAssetMoves(); return handlers[0]; };

  it('a board an agent moved while the socket was down: its kept draft follows it, edits and all', async () => {
    const global = assetStudioDraftKey('moodboard', 'global', 'b1');
    const character = assetStudioDraftKey('character', 'project', 'c1', 'pA');
    useAssetStudioDraftStore.setState({ entries: {
      [global]: entry({ name: 'Edited', projectId: undefined }, { dirty: true, revision: 4 }),
      [character]: { ...entry({ projectId: 'pA' }), savedId: 'c1' },
    } });
    api.fetchMoodboard.mockResolvedValue({ id: 'b1', projectId: 'pB' });
    api.fetchCharacter.mockResolvedValue({ id: 'c1', projectId: undefined });

    listen()({ type: 'socketReconnected' });

    const project = assetStudioDraftKey('moodboard', 'project', 'b1', 'pB');
    await vi.waitFor(() => expect(useAssetStudioDraftStore.getState().entries[project]).toBeTruthy());
    const state = useAssetStudioDraftStore.getState();
    expect(state.entries[project]).toMatchObject({ draft: { name: 'Edited', projectId: 'pB' }, dirty: true, revision: 4 });
    expect(resolveAssetStudioDraftKey(state, global)).toBe(project);
    await vi.waitFor(() => expect(useAssetStudioDraftStore.getState()
      .entries[assetStudioDraftKey('character', 'global', 'c1')]?.draft).toEqual({ projectId: undefined }));
    expect(api.fetchMoodboard).toHaveBeenCalledWith('b1');
    expect(api.fetchCharacter).toHaveBeenCalledWith('c1');
  });

  it('reads each kept asset once, never a new draft, and leaves a draft whose asset is gone or unread', async () => {
    const fresh = assetStudioDraftKey('moodboard', 'global', 'new');
    const gone = assetStudioDraftKey('moodboard', 'global', 'b2');
    const failed = assetStudioDraftKey('character', 'global', 'c2');
    const stays = assetStudioDraftKey('moodboard', 'project', 'b3', 'pA');
    const seenFromB = assetStudioDraftKey('moodboard', 'project', 'b3', 'pB');
    useAssetStudioDraftStore.setState({ entries: {
      [fresh]: { ...entry({ name: 'New' }), savedId: null },
      [gone]: { ...entry({ name: 'Gone' }), savedId: 'b2' },
      [failed]: { ...entry({ name: 'Unread' }), savedId: 'c2' },
      [stays]: { ...entry({ projectId: 'pA' }), savedId: 'b3' },
      [seenFromB]: { ...entry({ projectId: 'pA' }), savedId: 'b3' },
    } });
    api.fetchMoodboard.mockImplementation(async (id: string) => (id === 'b3' ? { id, projectId: 'pA' } : null));
    api.fetchCharacter.mockRejectedValue(new Error('offline'));

    listen()({ type: 'socketReconnected' });

    await vi.waitFor(() => expect(api.fetchCharacter).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(api.fetchMoodboard.mock.calls.map(([id]) => id).sort()).toEqual(['b2', 'b3']);
    const state = useAssetStudioDraftStore.getState();
    expect(Object.keys(state.entries).sort()).toEqual([fresh, gone, failed, stays, seenFromB].sort());
    expect(state.entries[stays].draft).toEqual({ projectId: 'pA' });
  });
});
