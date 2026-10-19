import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => [] as Array<(event: unknown) => void>);
vi.mock('../lib/wsClient', () => ({ wsClient: { subscribe: (handler: (event: unknown) => void) => {
  handlers.push(handler); return () => {}; } } }));

import { assetStudioDraftKey, emptyAssetStudioEntry, resolveAssetStudioDraftKey,
  useAssetStudioDraftStore } from './assetStudioDraftStore';
import { followAssetMoves } from '../lib/keptDraftMoves';

const entry = (draft: object, extra = {}) => ({ ...emptyAssetStudioEntry(draft), savedId: 'b1', loaded: true, ...extra });

beforeEach(() => { useAssetStudioDraftStore.setState({ entries: {}, aliases: {} }); });

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
