/**
 * Error copy round 3b, item 2: every retry button redoes the failure it sits
 * beside (GM: "A Retry that does something else is a defect."), and the
 * reason is GM's short line only where it does.
 *
 * - A Studio with no project open said "No project is open. Open one from
 *   Projects to use its assets." beside "Retry loading", which only checked
 *   the project again and did nothing: no button there now.
 * - Undo in the delete toast restores the asset deleted last. A later delete
 *   that failed showed its line in that toast, beside an Undo that restores
 *   a different asset (and the Studio hid its own notice while the toast was
 *   up). Now the toast shows only Undo's own failure, short (Undo redoes it),
 *   and the delete's failure stays in the Studio's notice.
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Character } from '../../src/types';

const api = vi.hoisted(() => ({ characters: vi.fn(), character: vi.fn(), boards: vi.fn(), board: vi.fn(),
  deleteMoodboard: vi.fn(), deleteCharacter: vi.fn() }));
vi.mock('../../src/lib/api', async (original) => ({ ...await original<typeof import('../../src/lib/api')>(),
  fetchCharacters: api.characters, fetchCharacter: api.character, fetchMoodboards: api.boards, fetchMoodboard: api.board,
  deleteMoodboard: api.deleteMoodboard, deleteCharacter: api.deleteCharacter }));
const trash = vi.hoisted(() => ({ restoreTrashed: vi.fn() }));
vi.mock('../../src/lib/trash', async (original) => ({ ...await original<typeof import('../../src/lib/trash')>(),
  restoreTrashed: trash.restoreTrashed }));
vi.mock('../../src/components/character-studio/CharacterTestPanel', () => ({ CharacterTestPanel: () => null }));

import { CharacterStudioView } from '../../src/components/character-studio/CharacterStudioView';
import { MoodboardStudioView } from '../../src/components/moodboard-studio/MoodboardStudioView';
import { UndoDeleteToast } from '../../src/components/asset-trash/AssetTrash';
import { useAssetDelete } from '../../src/hooks/useAssetDelete';
import { useUIStore } from '../../src/store/uiStore';
import { useAssetStudioDraftStore } from '../../src/store/assetStudioDraftStore';
import { RequestFailedError } from '../../src/lib/errorCopy';
import { setOpenProject } from '../../src/test/projectState';

const initialUI = useUIStore.getState();
const character = (id = 'character-a'): Character => ({ id, name: 'Original character', version: 1, subjectType: 'human',
  referenceViews: [], frozenTraitString: '', seed: 1, consistencyStrength: 0.8, thumbnail: '', createdAt: '', updatedAt: '' });
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
const unavailable = (heading: string) => new RequestFailedError(heading, 503);

beforeEach(() => {
  useUIStore.setState(initialUI, true);
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  for (const mock of [...Object.values(api), trash.restoreTrashed]) mock.mockReset();
  api.characters.mockResolvedValue([]); api.boards.mockResolvedValue([]);
  api.character.mockResolvedValue(character()); api.board.mockResolvedValue(null);
});
afterEach(() => { cleanup(); setOpenProject(['project-one', 'First project']); });

describe('a Studio with no project open', () => {
  it('Character: says why, with no Retry loading that would do nothing', async () => {
    setOpenProject(null);
    useUIStore.getState().enterCharacterEditor('character-a', 'project');
    render(<CharacterStudioView />); await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('No project is open. Open one from Projects to use its assets.');
    expect(screen.queryByRole('button', { name: 'Retry loading' })).toBeNull();
  });

  it('Moodboard: the same', async () => {
    setOpenProject(null);
    useUIStore.getState().enterMoodboardEditor('board-a', 'project');
    render(<MoodboardStudioView />); await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('No project is open. Open one from Projects to use its assets.');
    expect(screen.queryByRole('button', { name: 'Retry loading' })).toBeNull();
  });
});

describe('Undo in the delete toast', () => {
  it('a later delete that failed is not shown beside the Undo for the earlier one', async () => {
    api.deleteMoodboard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(unavailable("Couldn't delete the moodboard."));
    const { result } = renderHook(() => useAssetDelete('moodboard'));
    await act(async () => { await result.current.remove({ id: 'a', name: 'A', scope: 'global' }); });
    await act(async () => { await result.current.remove({ id: 'b', name: 'B', scope: 'global' }); });
    expect(result.current.lastDeleted?.id).toBe('a');
    // The toast (Undo restores A) says nothing about B; the Studio's notice does.
    expect(result.current.undoError).toBeNull();
    const line = 'Nebula couldn’t delete the moodboard because the server didn’t respond. Try again.';
    expect(result.current.deleteError).toEqual({ heading: '', reason: line, button: line, cause: 'Nebula didn’t respond. Try again.',
      what: 'delete the moodboard', status: 503 });
  });

  it('Undo\'s own failure shows in the toast in the because form, ending in Try again, because Undo redoes it', async () => {
    api.deleteMoodboard.mockResolvedValueOnce(undefined);
    trash.restoreTrashed.mockRejectedValueOnce(unavailable("Couldn't restore the moodboard."));
    const { result } = renderHook(() => useAssetDelete('moodboard'));
    await act(async () => { await result.current.remove({ id: 'a', name: 'A', scope: 'global' }); });
    await act(async () => { await result.current.undo(); });
    expect(result.current.undoError).toBe('Nebula couldn’t restore the moodboard because the server didn’t respond. Try again.');
    expect(result.current.deleteError).toBeNull();
    const onUndo = vi.fn();
    render(<UndoDeleteToast name="A" error={result.current.undoError} onUndo={onUndo} onDismiss={() => {}} />);
    expect(screen.getByRole('status').textContent).toContain('Nebula couldn’t restore the moodboard because the server didn’t respond. Try again.');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});

describe('a failed load’s Try again is described by the line beside it', () => {
  // The Studios' Recently deleted list also fetches: an empty list.
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { headers: { 'content-type': 'application/json' } })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const described = (button: HTMLElement) => {
    const id = button.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    return document.getElementById(id!);
  };

  it('Character', async () => {
    api.characters.mockRejectedValue(unavailable('Couldn’t load the character.'));
    api.character.mockRejectedValue(unavailable('Couldn’t load the character.'));
    useUIStore.getState().enterCharacterEditor('character-a');
    render(<CharacterStudioView />); await settle();
    const line = described(screen.getByRole('button', { name: 'Try again' }));
    expect(line).toHaveTextContent('Nebula couldn’t load the character because the server didn’t respond. Try again.');
  });

  it('Moodboard', async () => {
    api.board.mockRejectedValue(unavailable('Couldn’t load the moodboard.'));
    api.boards.mockRejectedValue(unavailable('Couldn’t load the moodboard.'));
    useUIStore.getState().enterMoodboardEditor('board-a', 'project');
    render(<MoodboardStudioView />); await settle();
    const line = described(screen.getByRole('button', { name: 'Try again' }));
    expect(line).toHaveTextContent(/^Nebula couldn’t load the moodboard because the server didn’t respond\. Try again\.$/);
  });
});
