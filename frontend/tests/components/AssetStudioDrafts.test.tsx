import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Character, Moodboard } from '../../src/types';

const api = vi.hoisted(() => ({ characters: vi.fn(), boards: vi.fn(), createCharacter: vi.fn(),
  updateCharacter: vi.fn(), createBoard: vi.fn(), updateBoard: vi.fn(), analyze: vi.fn(), upload: vi.fn(), project: vi.fn() }));
vi.mock('../../src/lib/api', async (original) => ({ ...await original<typeof import('../../src/lib/api')>(),
  fetchCharacters: api.characters, fetchMoodboards: api.boards, createCharacter: api.createCharacter,
  updateCharacter: api.updateCharacter, createMoodboard: api.createBoard, updateMoodboard: api.updateBoard,
  analyzeMoodboard: api.analyze }));
vi.mock('../../src/lib/backend', async (original) => ({ ...await original<typeof import('../../src/lib/backend')>(),
  apiFetch: api.upload }));
vi.mock('../../src/lib/currentProject', () => ({ getCurrentProject: api.project }));
vi.mock('../../src/components/character-studio/CharacterTestPanel', () => ({ CharacterTestPanel: () => null }));

import { CharacterStudioView } from '../../src/components/character-studio/CharacterStudioView';
import { MoodboardStudioView } from '../../src/components/moodboard-studio/MoodboardStudioView';
import { useUIStore } from '../../src/store/uiStore';
import { assetStudioDraftKey, useAssetStudioDraftStore } from '../../src/store/assetStudioDraftStore';
import { NEW_CHARACTER_SENTINEL, NEW_MOODBOARD_SENTINEL } from '../../src/lib/studioSentinels';

const initialUI = useUIStore.getState();
const character = (id = 'character-a', name = 'Original character'): Character => ({ id, name,
  version: 1, subjectType: 'human', referenceViews: ['/one.png', '/two.png', '/three.png'],
  frozenTraitString: 'Verbatim traits', seed: 14, consistencyStrength: 0.8, thumbnail: '/one.png',
  createdAt: '', updatedAt: '' });
const board = (id = 'board-a', name = 'Original board'): Moodboard => ({ id, name, version: 1,
  images: [{ id: 'image-one', url: '/one.png', weight: 1, notes: '', excluded: false }],
  notes: 'Original notes', mode: 'look', strength: 0.7, analysis: null, thumbnail: '/one.png',
  createdAt: '', updatedAt: '' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } }); }
function leave(view: ReturnType<typeof render>) {
  fireEvent.click(screen.getByRole('button', { name: 'Back to Canvas' }));
  expect(useUIStore.getState().viewMode).toBe('canvas'); view.unmount();
}
function characterUpload(view: ReturnType<typeof render>) {
  const input = view.container.querySelector<HTMLInputElement>('input[type=file]')!;
  fireEvent.change(input, { target: { files: [new File(['image'], 'reference.png', { type: 'image/png' })] } });
}

beforeEach(() => {
  vi.useFakeTimers(); useUIStore.setState(initialUI, true);
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {}, projectId: null });
  for (const mock of Object.values(api)) mock.mockReset();
  api.project.mockResolvedValue({ id: 'project-one', name: 'First project' });
  api.characters.mockImplementation(async (scope: string) => scope === 'global' ? [character(), character('character-b', 'Other character')] : []);
  api.boards.mockImplementation(async (scope: string) => scope === 'global' ? [board(), board('board-b', 'Other board')] : []);
  api.createCharacter.mockResolvedValue(character('created-character'));
  api.updateCharacter.mockImplementation(async (id, body) => ({ ...character(id), ...body }));
  api.createBoard.mockResolvedValue(board('created-board'));
  api.updateBoard.mockImplementation(async (id, body) => ({ ...board(id), ...body }));
  api.upload.mockResolvedValue(new Response(JSON.stringify({ url: '/uploaded.png' }), { headers: { 'content-type': 'application/json' } }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); useUIStore.setState(initialUI, true);
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {}, projectId: null }); });

describe('asset studio workspace continuity', () => {
  it('retains an invalid Character draft verbatim through return and keeps scoped drafts separate', async () => {
    useUIStore.getState().enterCharacterEditor(NEW_CHARACTER_SENTINEL);
    const first = render(<CharacterStudioView />); await settle();
    change('Name', 'Unfinished identity'); change('Frozen trait string', '  exact\ntraits  ');
    leave(first); useUIStore.getState().enterCharacterEditor(NEW_CHARACTER_SENTINEL);
    const reopened = render(<CharacterStudioView />); await settle();
    expect(screen.getByLabelText('Name')).toHaveValue('Unfinished identity');
    expect(screen.getByLabelText(/^Frozen trait string/)).toHaveValue('  exact\ntraits  ');
    reopened.unmount(); useUIStore.getState().enterCharacterEditor(NEW_CHARACTER_SENTINEL, 'project');
    render(<CharacterStudioView />); await settle();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(api.createCharacter).not.toHaveBeenCalled(); expect(api.updateCharacter).not.toHaveBeenCalled();
  });

  it('retains a pending Character edit and saves the latest recipe after reopening', async () => {
    useUIStore.getState().enterCharacterEditor('character-a');
    const first = render(<CharacterStudioView />); await settle();
    change('Name', 'New name before debounce'); leave(first);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(api.updateCharacter).not.toHaveBeenCalled();
    useUIStore.getState().enterCharacterEditor('character-a'); render(<CharacterStudioView />); await settle();
    expect(screen.getByLabelText('Name')).toHaveValue('New name before debounce');
    await act(async () => { vi.advanceTimersByTime(600); }); await settle();
    expect(api.updateCharacter).toHaveBeenCalledExactlyOnceWith('character-a', expect.objectContaining({
      name: 'New name before debounce', frozenTraitString: 'Verbatim traits', seed: 14,
      referenceViews: ['/one.png', '/two.png', '/three.png'],
    }));
  });

  it('records a pending create under its original draft without navigating away from a newer Character', async () => {
    const request = deferred<Character>(); api.createCharacter.mockReturnValue(request.promise);
    useUIStore.getState().enterCharacterEditor(NEW_CHARACTER_SENTINEL);
    const view = render(<CharacterStudioView />); await settle();
    const key = assetStudioDraftKey('character', 'global', NEW_CHARACTER_SENTINEL);
    act(() => useAssetStudioDraftStore.getState().edit(key, () => ({ ...character(), name: 'Original draft' })));
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(api.createCharacter).toHaveBeenCalledOnce();
    act(() => useUIStore.getState().enterCharacterEditor('character-b')); await settle();
    await act(async () => request.resolve(character('created-character'))); await settle();
    expect(useUIStore.getState().characterEditorId).toBe('character-b');
    expect(screen.getByLabelText('Name')).toHaveValue('Other character');
    expect(useAssetStudioDraftStore.getState().aliases[key]).toBe(assetStudioDraftKey('character', 'global', 'created-character'));
    expect(useAssetStudioDraftStore.getState().entries[assetStudioDraftKey('character', 'global', 'created-character')].savedId).toBe('created-character');
    view.unmount(); useUIStore.getState().enterCharacterEditor(NEW_CHARACTER_SENTINEL);
    render(<CharacterStudioView />); await settle();
    expect(screen.getByLabelText('Name')).toHaveValue('Original draft');
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(api.createCharacter).toHaveBeenCalledOnce();
  });

  it('merges Character uploads into latest text but discards an old upload after leaving and reopening', async () => {
    const upload = deferred<Response>(); api.upload.mockReturnValue(upload.promise);
    useUIStore.getState().enterCharacterEditor(NEW_CHARACTER_SENTINEL);
    const view = render(<CharacterStudioView />); await settle();
    characterUpload(view); change('Name', 'Text typed during upload');
    await act(async () => upload.resolve(new Response(JSON.stringify({ url: '/late-one.png' })))); await settle();
    expect(screen.getByLabelText('Name')).toHaveValue('Text typed during upload');
    expect(screen.getByText('Reference views (1)')).toBeTruthy();
    const second = deferred<Response>(); api.upload.mockReturnValue(second.promise); characterUpload(view);
    leave(view); useUIStore.getState().enterCharacterEditor(NEW_CHARACTER_SENTINEL);
    render(<CharacterStudioView />); await settle();
    await act(async () => second.resolve(new Response(JSON.stringify({ url: '/discarded.png' })))); await settle();
    expect(screen.getByText('Reference views (1)')).toBeTruthy();
    expect(useAssetStudioDraftStore.getState().entries[assetStudioDraftKey('character', 'global', NEW_CHARACTER_SENTINEL)].draft)
      .toMatchObject({ referenceViews: ['/late-one.png'] });
  });

  it('retains a Moodboard with no images without save or analysis on return', async () => {
    useUIStore.getState().enterMoodboardEditor(NEW_MOODBOARD_SENTINEL);
    const view = render(<MoodboardStudioView />); await settle();
    change('Name', 'Unfinished look'); change('Notes', '  Keep my notes\nunchanged  '); leave(view);
    useUIStore.getState().enterMoodboardEditor(NEW_MOODBOARD_SENTINEL);
    render(<MoodboardStudioView />); await settle();
    expect(screen.getByLabelText('Name')).toHaveValue('Unfinished look');
    expect(screen.getByLabelText('Notes')).toHaveValue('  Keep my notes\nunchanged  ');
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(api.createBoard).not.toHaveBeenCalled(); expect(api.updateBoard).not.toHaveBeenCalled();
    expect(api.analyze).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer Character edit with an earlier save response', async () => {
    const request = deferred<Character>(); api.updateCharacter.mockReturnValue(request.promise);
    useUIStore.getState().enterCharacterEditor('character-a'); render(<CharacterStudioView />); await settle();
    change('Name', 'First save'); await act(async () => { vi.advanceTimersByTime(600); });
    change('Name', 'Newer text'); await act(async () => request.resolve(character('character-a', 'First save')));
    expect(screen.getByLabelText('Name')).toHaveValue('Newer text');
    expect(useAssetStudioDraftStore.getState().entries[assetStudioDraftKey('character', 'global', 'character-a')].dirty).toBe(true);
  });

  it('retains pending Moodboard changes and isolates a late save from another selection', async () => {
    const request = deferred<Moodboard>(); api.updateBoard.mockReturnValue(request.promise);
    useUIStore.getState().enterMoodboardEditor('board-a');
    const view = render(<MoodboardStudioView />); await settle();
    change('Notes', 'Unsaved notes'); leave(view);
    useUIStore.getState().enterMoodboardEditor('board-a'); render(<MoodboardStudioView />); await settle();
    expect(screen.getByLabelText('Notes')).toHaveValue('Unsaved notes');
    await act(async () => { vi.advanceTimersByTime(600); });
    act(() => useUIStore.getState().enterMoodboardEditor('board-b')); await settle();
    await act(async () => request.resolve({ ...board(), notes: 'Unsaved notes' })); await settle();
    expect(screen.getByLabelText('Name')).toHaveValue('Other board');
    expect(screen.getByLabelText('Notes')).toHaveValue('Original notes');
    expect(useUIStore.getState().moodboardEditorId).toBe('board-b');
  });

  it('rejects a Moodboard upload belonging to an explicitly replaced new draft', async () => {
    const upload = deferred<Response>(); api.upload.mockReturnValue(upload.promise);
    useUIStore.getState().enterMoodboardEditor(NEW_MOODBOARD_SENTINEL);
    render(<MoodboardStudioView />); await settle();
    fireEvent.change(screen.getByLabelText('Add Images'), { target: { files: [new File(['image'], 'a.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByRole('button', { name: '+ New Moodboard' })); await settle();
    change('Notes', 'Replacement draft');
    await act(async () => upload.resolve(new Response(JSON.stringify({ url: '/discarded.png' })))); await settle();
    expect(screen.getByText('Images (0)')).toBeTruthy();
    expect(screen.getByLabelText('Notes')).toHaveValue('Replacement draft');
    expect(api.createBoard).not.toHaveBeenCalled();
  });

  it('analyzes only on an explicit click and preserves edits made during the request', async () => {
    const analysis = deferred<Moodboard>(); api.analyze.mockReturnValue(analysis.promise);
    useUIStore.getState().enterMoodboardEditor('board-a'); render(<MoodboardStudioView />); await settle();
    expect(api.analyze).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' })); await settle();
    expect(api.analyze).toHaveBeenCalledExactlyOnceWith('board-a');
    change('Notes', 'A newer direction');
    await act(async () => analysis.resolve({ ...board(), notes: 'Server analysis response' }));
    expect(screen.getByLabelText('Notes')).toHaveValue('A newer direction');
  });

  it('rejects an old Character load after selecting another asset', async () => {
    const old = deferred<Character[]>(); api.characters.mockImplementation(() => old.promise);
    useUIStore.getState().enterCharacterEditor('character-a'); render(<CharacterStudioView />); await settle();
    api.characters.mockImplementation(async (scope: string) => scope === 'global' ? [character('character-b', 'New selection')] : []);
    act(() => useUIStore.getState().enterCharacterEditor('character-b')); await settle();
    expect(screen.getByLabelText('Name')).toHaveValue('New selection');
    await act(async () => old.resolve([character()])); await settle();
    expect(screen.getByLabelText('Name')).toHaveValue('New selection');
    expect(api.updateCharacter).not.toHaveBeenCalled();
  });

  it('does not analyze an older save when the Moodboard was edited while saving', async () => {
    const save = deferred<Moodboard>(); api.updateBoard.mockReturnValue(save.promise);
    useUIStore.getState().enterMoodboardEditor('board-a'); render(<MoodboardStudioView />); await settle();
    change('Notes', 'Direction at click'); fireEvent.click(screen.getByRole('button', { name: 'Analyze' })); await settle();
    expect(api.updateBoard).toHaveBeenCalledOnce(); change('Notes', 'New direction before save returns');
    await act(async () => save.resolve({ ...board(), notes: 'Direction at click' })); await settle();
    expect(api.analyze).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Notes')).toHaveValue('New direction before save returns');
    expect(screen.getByText('Settings changed while saving. Analyze again when ready.')).toBeTruthy();
  });

  it('keeps a failed asset load behind explicit Retry instead of authoring an accidental replacement', async () => {
    api.characters.mockRejectedValue(new Error('Offline fixture'));
    useUIStore.getState().enterCharacterEditor('character-a'); render(<CharacterStudioView />); await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Offline fixture');
    expect(screen.queryByLabelText('Name')).toBeNull();
    api.characters.mockImplementation(async (scope: string) => scope === 'global' ? [character()] : []);
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' })); await settle();
    expect(screen.getByLabelText('Name')).toHaveValue('Original character');
    expect(api.createCharacter).not.toHaveBeenCalled(); expect(api.updateCharacter).not.toHaveBeenCalled();
  });

  it('resumes the canonical Character after create, edit, return, and opening the new route', async () => {
    useUIStore.getState().enterCharacterEditor(NEW_CHARACTER_SENTINEL);
    const view = render(<CharacterStudioView />); await settle();
    const sentinel = assetStudioDraftKey('character', 'global', NEW_CHARACTER_SENTINEL);
    act(() => useAssetStudioDraftStore.getState().edit(sentinel, () => ({ ...character(), name: 'Created draft' })));
    await act(async () => { vi.advanceTimersByTime(600); }); await settle();
    expect(useUIStore.getState().characterEditorId).toBe('created-character');
    change('Name', 'Latest canonical name'); leave(view);
    useUIStore.getState().enterCharacterEditor(NEW_CHARACTER_SENTINEL); render(<CharacterStudioView />); await settle();
    expect(useUIStore.getState().characterEditorId).toBe('created-character');
    expect(screen.getByLabelText('Name')).toHaveValue('Latest canonical name');
    await act(async () => { vi.advanceTimersByTime(600); }); await settle();
    expect(api.updateCharacter).toHaveBeenCalledExactlyOnceWith('created-character', expect.objectContaining({ name: 'Latest canonical name' }));
    expect(api.createCharacter).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '+ New Character' })); await settle();
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(useUIStore.getState().characterEditorId).toBe(NEW_CHARACTER_SENTINEL);
  });

  it('resumes the canonical Moodboard after create and newer saved-ID edits', async () => {
    useUIStore.getState().enterMoodboardEditor(NEW_MOODBOARD_SENTINEL);
    const view = render(<MoodboardStudioView />); await settle();
    const sentinel = assetStudioDraftKey('moodboard', 'global', NEW_MOODBOARD_SENTINEL);
    act(() => useAssetStudioDraftStore.getState().edit(sentinel, () => ({ ...board(), notes: 'Created notes' })));
    await act(async () => { vi.advanceTimersByTime(600); }); await settle();
    expect(useUIStore.getState().moodboardEditorId).toBe('created-board');
    change('Notes', 'Canonical notes'); leave(view);
    useUIStore.getState().enterMoodboardEditor(NEW_MOODBOARD_SENTINEL); render(<MoodboardStudioView />); await settle();
    expect(useUIStore.getState().moodboardEditorId).toBe('created-board');
    expect(screen.getByLabelText('Notes')).toHaveValue('Canonical notes');
    await act(async () => { vi.advanceTimersByTime(600); }); await settle();
    expect(api.updateBoard).toHaveBeenCalledExactlyOnceWith('created-board', expect.objectContaining({ notes: 'Canonical notes' }));
    expect(api.createBoard).toHaveBeenCalledOnce();
  });

  it('keeps first new Moodboard analysis busy through saved-ID adoption and prevents duplicate analysis', async () => {
    const request = deferred<Moodboard>(); api.analyze.mockReturnValue(request.promise);
    useUIStore.getState().enterMoodboardEditor(NEW_MOODBOARD_SENTINEL); render(<MoodboardStudioView />); await settle();
    act(() => useAssetStudioDraftStore.getState().edit(assetStudioDraftKey('moodboard', 'global', NEW_MOODBOARD_SENTINEL), () => board()));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' })); await settle();
    expect(api.analyze).toHaveBeenCalledExactlyOnceWith('created-board');
    expect(screen.getByRole('button', { name: 'Analyzing' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Analyzing' })); await settle();
    expect(api.analyze).toHaveBeenCalledOnce();
    await act(async () => request.resolve(board('created-board'))); await settle();
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeEnabled();
  });

  it('keeps B analysis owned when an earlier A request settles and retains A lock on return', async () => {
    const a = deferred<Moodboard>(); const b = deferred<Moodboard>();
    api.analyze.mockImplementation((id: string) => id === 'board-a' ? a.promise : b.promise);
    useUIStore.getState().enterMoodboardEditor('board-a'); render(<MoodboardStudioView />); await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' })); await settle();
    act(() => useUIStore.getState().enterMoodboardEditor('board-b')); await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' })); await settle();
    act(() => useUIStore.getState().enterMoodboardEditor('board-a')); await settle();
    expect(screen.getByRole('button', { name: 'Analyzing' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Analyzing' })); await settle();
    expect(api.analyze).toHaveBeenCalledTimes(2);
    act(() => useUIStore.getState().enterMoodboardEditor('board-b')); await settle();
    await act(async () => a.resolve({ ...board(), notes: 'Stale A result' })); await settle();
    expect(screen.getByRole('button', { name: 'Analyzing' })).toBeDisabled();
    expect(screen.getByLabelText('Notes')).toHaveValue('Original notes');
    expect(api.analyze).toHaveBeenCalledTimes(2);
    await act(async () => b.resolve(board('board-b'))); await settle();
    expect(screen.getByRole('button', { name: 'Analyze' })).toBeEnabled();
  });

  it('preserves separate project drafts when backend identity changes and restores the original project', async () => {
    useUIStore.getState().enterCharacterEditor(NEW_CHARACTER_SENTINEL, 'project');
    const first = render(<CharacterStudioView />); await settle(); change('Name', 'First project draft'); leave(first);
    api.project.mockResolvedValue({ id: 'project-two', name: 'Second project' });
    useUIStore.getState().enterCharacterEditor(NEW_CHARACTER_SENTINEL, 'project');
    const second = render(<CharacterStudioView />); await settle();
    expect(screen.getByLabelText('Name')).toHaveValue(''); change('Name', 'Second project draft'); leave(second);
    api.project.mockResolvedValue({ id: 'project-one', name: 'First project' });
    useUIStore.getState().enterCharacterEditor(NEW_CHARACTER_SENTINEL, 'project'); render(<CharacterStudioView />); await settle();
    expect(screen.getByLabelText('Name')).toHaveValue('First project draft');
    expect(useAssetStudioDraftStore.getState().entries[assetStudioDraftKey('character', 'project', 'new', 'project-one')].draft)
      .toMatchObject({ name: 'First project draft', projectId: 'project-one' });
    expect(useAssetStudioDraftStore.getState().entries[assetStudioDraftKey('character', 'project', 'new', 'project-two')].draft)
      .toMatchObject({ name: 'Second project draft', projectId: 'project-two' });
    expect(api.createCharacter).not.toHaveBeenCalled(); expect(api.updateCharacter).not.toHaveBeenCalled();
  });

  it('verifies project identity again before autosave and retains the old project draft', async () => {
    useUIStore.getState().enterMoodboardEditor(NEW_MOODBOARD_SENTINEL, 'project'); render(<MoodboardStudioView />); await settle();
    const firstKey = assetStudioDraftKey('moodboard', 'project', 'new', 'project-one');
    act(() => useAssetStudioDraftStore.getState().edit(firstKey, () => ({ ...board(), notes: 'Old project direction', projectId: 'project-one' })));
    api.project.mockResolvedValue({ id: 'project-two', name: 'Recovered backend project' });
    await act(async () => { vi.advanceTimersByTime(600); }); await settle();
    expect(api.createBoard).not.toHaveBeenCalled(); expect(api.updateBoard).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Notes')).toHaveValue('');
    expect(useAssetStudioDraftStore.getState().entries[firstKey].draft).toMatchObject({ notes: 'Old project direction', projectId: 'project-one' });
    expect(useAssetStudioDraftStore.getState().entries[assetStudioDraftKey('moodboard', 'project', 'new', 'project-two')].draft)
      .toMatchObject({ notes: '', projectId: 'project-two' });
  });
});
