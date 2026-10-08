import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CharacterTestPanel } from '../../src/components/character-studio/CharacterTestPanel';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import { useAssetStudioDraftStore, assetStudioDraftKey, emptyAssetStudioEntry } from '../../src/store/assetStudioDraftStore';

const initialUI = useUIStore.getState(); const initialGraph = useGraphStore.getState();
const draft = { name: 'Saved character', subjectType: 'human' as const,
  referenceViews: ['/one.png', '/two.png', '/three.png'], frozenTraitString: 'Exact traits', seed: 2, consistencyStrength: 0.8 };
const key = assetStudioDraftKey('character', 'global', 'saved-character');
const add = vi.fn(); const execute = vi.fn();
function deferred() {
  let resolve!: (id: string | null) => void;
  const promise = new Promise<string | null>((settle) => { resolve = settle; });
  return { promise, resolve };
}
beforeEach(() => {
  useUIStore.setState(initialUI, true); useGraphStore.setState({ ...initialGraph, addCharacterNode: add, executeGraph: execute }, true);
  useAssetStudioDraftStore.setState({ entries: { [key]: { ...emptyAssetStudioEntry(draft), loaded: true, savedId: 'saved-character' } }, aliases: {}, projectId: null });
  add.mockReset(); execute.mockReset(); useUIStore.getState().enterCharacterEditor('saved-character');
});
afterEach(() => { cleanup(); useUIStore.setState(initialUI, true); useGraphStore.setState(initialGraph, true);
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {}, projectId: null }); });
function open() { return render(<CharacterTestPanel characterId="saved-character" draft={draft} thumbnail="/one.png" canTest />); }

it('returns after its explicit node authoring succeeds without generation', async () => {
  add.mockResolvedValue('authored-node'); open();
  fireEvent.click(screen.getByRole('button', { name: 'Test on canvas →' })); await act(async () => {});
  expect(add).toHaveBeenCalledExactlyOnceWith('saved-character', { x: 400, y: 300 }, { name: 'Saved character', thumbnail: '/one.png' });
  expect(useUIStore.getState().viewMode).toBe('canvas'); expect(execute).not.toHaveBeenCalled();
});

it('preserves authored work but rejects delayed navigation after opening Moodboard', async () => {
  const request = deferred(); add.mockReturnValue(request.promise); open();
  fireEvent.click(screen.getByRole('button', { name: 'Test on canvas →' }));
  act(() => useUIStore.getState().enterMoodboardEditor('board-b'));
  await act(async () => request.resolve('authored-node'));
  expect(add).toHaveBeenCalledOnce(); expect(useUIStore.getState().viewMode).toBe('moodboard-editor');
  expect(useUIStore.getState().moodboardEditorId).toBe('board-b'); expect(execute).not.toHaveBeenCalled();
});

it('rejects delayed navigation after the old panel unmounts and the same Character reopens', async () => {
  const request = deferred(); add.mockReturnValue(request.promise); const old = open();
  fireEvent.click(screen.getByRole('button', { name: 'Test on canvas →' }));
  act(() => useUIStore.getState().exitCharacterEditor()); old.unmount();
  useUIStore.getState().enterCharacterEditor('saved-character'); open();
  await act(async () => request.resolve('authored-node'));
  expect(useUIStore.getState().viewMode).toBe('character-editor'); expect(execute).not.toHaveBeenCalled();
});

it('stays in the studio when no node was authored', async () => {
  add.mockResolvedValue(null); open(); fireEvent.click(screen.getByRole('button', { name: 'Test on canvas →' })); await act(async () => {});
  expect(useUIStore.getState().viewMode).toBe('character-editor'); expect(execute).not.toHaveBeenCalled();
});
