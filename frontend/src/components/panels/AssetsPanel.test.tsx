import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Character, Moodboard } from '../../types';

const api = vi.hoisted(() => ({ fetchMoodboards: vi.fn(), fetchCharacters: vi.fn(), moveStoredAsset: vi.fn() }));
vi.mock('../../lib/api', () => api);
const presets = vi.hoisted(() => ({ fetchPresets: vi.fn(), deletePreset: vi.fn() }));
vi.mock('../../lib/createPresets', () => presets);
const trash = vi.hoisted(() => ({ fetchTrash: vi.fn(), restoreTrashed: vi.fn(), purgeTrashed: vi.fn(), emptyTrash: vi.fn() }));
vi.mock('../../lib/trash', async (importOriginal) => ({ ...(await importOriginal<object>()), ...trash }));
vi.mock('../../lib/backend', async (importOriginal) => ({ ...(await importOriginal<object>()), backendAssetUrlSync: (url: string) => url }));
const socket = vi.hoisted(() => ({ handlers: new Set<(event: unknown) => void>() }));
vi.mock('../../lib/wsClient', () => ({ wsClient: {
  subscribe: (handler: (event: unknown) => void) => { socket.handlers.add(handler); return () => socket.handlers.delete(handler); },
  connect: () => {}, send: () => {} } }));

import { AssetsPanel } from './AssetsPanel';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { setOpenProject } from '../../test/projectState';
import { assetStudioDraftKey, emptyAssetStudioEntry, useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';

const board = { id: 'b1', name: 'Warm editorial', thumbnail: '/api/outputs/a.png', images: [{}], mode: 'look' } as unknown as Moodboard;
const character = { id: 'c1', name: 'Nari', thumbnail: '/api/outputs/n.png', referenceViews: ['a', 'b', 'c'] } as unknown as Character;

const addMoodboardNode = vi.fn();
const addCharacterNode = vi.fn();
const enterMoodboardEditor = vi.fn();
const enterCharacterEditor = vi.fn();

beforeEach(() => {
  presets.fetchPresets.mockReset().mockResolvedValue([]);
  presets.deletePreset.mockReset().mockResolvedValue(undefined);
  Object.values(trash).forEach((mock) => mock.mockReset());
  trash.fetchTrash.mockResolvedValue([]);
  trash.restoreTrashed.mockResolvedValue(undefined);
  api.fetchMoodboards.mockReset().mockResolvedValue([board]);
  presets.fetchPresets.mockReset().mockResolvedValue([]);
  api.fetchCharacters.mockReset().mockResolvedValue([character]);
  api.moveStoredAsset.mockReset().mockImplementation(async (_kind: string, _id: string, to: string | null) =>
    ({ status: 'moved', from: null, to, fromName: 'Global', toName: to ? 'Shoot A' : 'Global', detail: '', asset: {} }));
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  [addMoodboardNode, addCharacterNode, enterMoodboardEditor, enterCharacterEditor].forEach((mock) => mock.mockReset());
  useGraphStore.setState({ addMoodboardNode, addCharacterNode, nodes: [] } as never);
  useUIStore.setState({ enterMoodboardEditor, enterCharacterEditor } as never);
  setOpenProject(['pA', 'Shoot A'], [['pB', 'Shoot B']]);
});

function renderPanel() {
  return render(<ReactFlowProvider><AssetsPanel /></ReactFlowProvider>);
}

async function openTab(name: 'Moodboards' | 'Characters') {
  renderPanel();
  fireEvent.click(screen.getByRole('tab', { name }));
}

describe.each([
  { tab: 'Moodboards' as const, item: 'Warm editorial', add: addMoodboardNode, open: enterMoodboardEditor, id: 'b1' },
  { tab: 'Characters' as const, item: 'Nari', add: addCharacterNode, open: enterCharacterEditor, id: 'c1' },
])('Assets panel $tab', ({ tab, item, add, open, id }) => {
  it('a click only selects: nothing is added to the canvas', async () => {
    await openTab(tab);
    const row = await screen.findByRole('button', { name: new RegExp(`^${item}`) });
    fireEvent.click(row);
    expect(add).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: new RegExp(`^${item}`), pressed: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Add ${item} to canvas` })).toBeTruthy();
  });

  it('a double-click opens the Studio and adds nothing', async () => {
    await openTab(tab);
    const row = await screen.findByRole('button', { name: new RegExp(`^${item}`) });
    // A double-click is two clicks, then dblclick.
    fireEvent.click(row);
    fireEvent.click(row);
    fireEvent.doubleClick(row);
    expect(open).toHaveBeenCalledWith(id, 'global');
    expect(add).not.toHaveBeenCalled();
  });

  it('"Add to canvas" adds one node; the Open button opens', async () => {
    await openTab(tab);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${item}`) }));
    fireEvent.click(screen.getByRole('button', { name: `Add ${item} to canvas` }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toBe(id);
    fireEvent.click(screen.getByRole('button', { name: `Open ${item}` }));
    expect(open).toHaveBeenCalledWith(id, 'global');
  });

  it('dragging still carries the item onto the canvas', async () => {
    await openTab(tab);
    const row = await screen.findByRole('button', { name: new RegExp(`^${item}`) });
    expect(row.getAttribute('draggable')).toBe('true');
    const setData = vi.fn();
    fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: '' } });
    expect(setData).toHaveBeenCalledWith(expect.stringContaining('application/'), expect.stringContaining(`"id":"${id}"`));
    expect(add).not.toHaveBeenCalled();
  });
});

describe('Assets panel moodboard count', () => {
  it('counts the set-aside images, and the card it adds or drops starts with that count', async () => {
    api.fetchMoodboards.mockResolvedValue([{ ...board, images: [
      { weight: 1, excluded: false }, { weight: 1, excluded: true }, { weight: 0, excluded: false }] }]);
    await openTab('Moodboards');
    expect(await screen.findByText('3 images · 2 set aside · look')).toBeTruthy();
    const row = screen.getByRole('button', { name: /^Warm editorial/ });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: 'Add Warm editorial to canvas' }));
    expect(addMoodboardNode.mock.calls[0][2]).toMatchObject({ imageCount: 3, setAsideCount: 2 });
    const setData = vi.fn();
    fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: '' } });
    expect(setData).toHaveBeenCalledWith(expect.stringContaining('application/'),
      expect.stringContaining('"imageCount":3,"setAsideCount":2'));
  });

  it('says "1 image" for one', async () => {
    await openTab('Moodboards');
    expect(await screen.findByText('1 image · look')).toBeTruthy();
  });

  it('lists again when the socket comes back, so a change made while it was down shows', async () => {
    await openTab('Moodboards');
    await screen.findByText('1 image · look');
    // Set aside by an agent while the backend restarted: no storedAssetChanged came.
    api.fetchMoodboards.mockResolvedValue([{ ...board, images: [{ weight: 1, excluded: false }, { weight: 1, excluded: true }] }]);
    act(() => { for (const handler of socket.handlers) handler({ type: 'socketReconnected' }); });
    expect(await screen.findByText('2 images · 1 set aside · look')).toBeTruthy();
  });
});

describe('Assets panel Project tab', () => {
  it('lists the open canvas project and lists again when the project changes', async () => {
    const boardA = { ...board, id: 'a1', name: 'A board' } as Moodboard;
    const boardB = { ...board, id: 'b2', name: 'B board' } as Moodboard;
    api.fetchMoodboards.mockImplementation(async (scope: string, projectId?: string) => (
      scope === 'global' ? [board] : projectId === 'pA' ? [boardA] : projectId === 'pB' ? [boardB] : []));
    await openTab('Moodboards');
    fireEvent.click(screen.getByRole('tab', { name: 'Project' }));
    expect(await screen.findByRole('button', { name: /^A board/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Project' }).getAttribute('title')).toBe('Assets in Shoot A');

    // The person, or an agent this tab follows, opens Shoot B.
    act(() => { setOpenProject(['pB', 'Shoot B'], [['pA', 'Shoot A']]); });
    expect(await screen.findByRole('button', { name: /^B board/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^A board/ })).toBeNull();
    expect(api.fetchMoodboards).toHaveBeenCalledWith('project', 'pB');

    fireEvent.click(screen.getByRole('button', { name: '+ New Moodboard' }));
    expect(enterMoodboardEditor).toHaveBeenCalledWith('new', 'project');
  });

  it('with no project open it says to open one, fetches nothing for it and New is off', async () => {
    setOpenProject(null);
    await openTab('Characters');
    fireEvent.click(screen.getByRole('tab', { name: 'Project' }));
    expect(await screen.findByText('Open a project to see its Characters.')).toBeTruthy();
    await waitFor(() => expect(api.fetchCharacters).toHaveBeenCalledTimes(1));
    expect(api.fetchCharacters).toHaveBeenCalledWith('global', undefined);
    const newButton = screen.getByRole('button', { name: '+ New Character' }) as HTMLButtonElement;
    expect(newButton.disabled).toBe(true);
    fireEvent.click(newButton);
    expect(enterCharacterEditor).not.toHaveBeenCalled();
    expect(screen.queryByText(/failed/i)).toBeNull();
  });
});

describe.each([
  { tab: 'Moodboards' as const, item: 'Warm editorial', kind: 'moodboard', id: 'b1' },
  { tab: 'Characters' as const, item: 'Nari', kind: 'character', id: 'c1' },
])('Assets panel Move ($tab)', ({ tab, item, kind, id }) => {
  it('a Global item moves into the open project, and a Studio draft kept for it follows', async () => {
    // A draft from an earlier Studio visit, with an unsaved edit.
    const kept = assetStudioDraftKey(kind as 'moodboard', 'global', id);
    useAssetStudioDraftStore.setState({ entries: { [kept]: { ...emptyAssetStudioEntry({ name: 'Edited, unsaved' }),
      savedId: id, loaded: true, dirty: true } }, aliases: {} });
    await openTab(tab);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${item}`) }));
    fireEvent.click(screen.getByRole('button', { name: /^Move/ }));
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Move to Shoot A']);
    const listed = api[kind === 'moodboard' ? 'fetchMoodboards' : 'fetchCharacters'].mock.calls.length;
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Shoot A' }));

    await waitFor(() => expect(api.moveStoredAsset).toHaveBeenCalledWith(kind, id, 'pA'));
    await waitFor(() => expect(api[kind === 'moodboard' ? 'fetchMoodboards' : 'fetchCharacters'].mock.calls.length).toBeGreaterThan(listed));
    const drafts = useAssetStudioDraftStore.getState();
    const moved = drafts.entries[assetStudioDraftKey(kind as 'moodboard', 'project', id, 'pA')];
    expect(moved?.draft).toEqual({ name: 'Edited, unsaved', projectId: 'pA' });
    expect(moved?.dirty).toBe(true);
    expect(drafts.entries[kept]).toBeUndefined();
  });

  it("a project item offers Move to Global; a refused move says why", async () => {
    api[kind === 'moodboard' ? 'fetchMoodboards' : 'fetchCharacters'].mockResolvedValue([
      { ...(kind === 'moodboard' ? board : character), projectId: 'pA' }]);
    api.moveStoredAsset.mockRejectedValueOnce(new Error('Move failed: No project has the id'));
    await openTab(tab);
    fireEvent.click(screen.getByRole('tab', { name: 'Project' }));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${item}`) }));
    fireEvent.click(screen.getByRole('button', { name: /^Move/ }));
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Move to Global']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Global' }));
    expect(await screen.findByText('Move failed: No project has the id')).toBeTruthy();
    expect(api.moveStoredAsset).toHaveBeenCalledWith(kind, id, null);
  });
});

// A Character or Style saved before Nebula checked its images can hold an
// outside link: the row keeps it listed but never loads that picture.
describe('Assets panel images from outside Nebula', () => {
  it('a Character row shows its placeholder and says why', async () => {
    api.fetchCharacters.mockResolvedValue([{ ...character, thumbnail: 'https://images.example.com/face.png' }]);
    const view = renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Characters' }));
    expect(await screen.findByText('Image link from outside Nebula')).toBeTruthy();
    expect(view.container.querySelector('img[src^="https://"]')).toBeNull();
    expect(screen.getByRole('button', { name: /^Nari/ })).toBeTruthy();
  });

  it('a Style row shows its placeholder and says why', async () => {
    presets.fetchPresets.mockImplementation(async (scope: string) => scope === 'global' ? [{
      id: 's1', name: 'Old noir', category: 'My Styles', prompt: '', params: {}, modelId: 'nano-banana',
      refImages: [], thumbnail: 'https://images.example.com/noir.png', version: 1, scope: 'global', projectId: null,
      createdAt: '', updatedAt: '' }] : []);
    const view = renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Styles' }));
    expect(await screen.findByText('Old noir')).toBeTruthy();
    expect(screen.getByText('Image link from outside Nebula')).toBeTruthy();
    expect(view.container.querySelector('img[src^="https://"]')).toBeNull();
  });
});

describe('Assets panel Styles', () => {
  const style = { id: 's1', name: 'Neon noir', category: 'My Styles', prompt: 'neon', params: {}, modelId: null,
    refImages: [], thumbnail: '', version: 1, scope: 'global', projectId: null, createdAt: '', updatedAt: '' };

  it('deletes a Style to Recently deleted with Undo, and Undo restores it', async () => {
    presets.fetchPresets.mockResolvedValue([style]);
    renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Styles' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Neon noir/ }));
    const listed = presets.fetchPresets.mock.calls.length;
    presets.fetchPresets.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Neon noir' }));

    await waitFor(() => expect(presets.deletePreset).toHaveBeenCalledWith('s1'));
    expect(await screen.findByText('Moved “Neon noir” to Recently deleted')).toBeTruthy();
    await waitFor(() => expect(presets.fetchPresets.mock.calls.length).toBeGreaterThan(listed));
    expect(await screen.findByText('No Styles yet.')).toBeTruthy();

    presets.fetchPresets.mockResolvedValue([style]);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(trash.restoreTrashed).toHaveBeenCalledWith('style', 's1'));
    expect(await screen.findByRole('button', { name: /^Neon noir/ })).toBeTruthy();
    expect(screen.queryByText('Moved “Neon noir” to Recently deleted')).toBeNull();
  });

  it('shows Recently deleted Styles for the scope it lists, and a refused delete says why', async () => {
    presets.fetchPresets.mockResolvedValue([style]);
    trash.fetchTrash.mockResolvedValue([{ kind: 'style', id: 's0', name: 'Old look', projectId: null,
      deletedAt: '2026-10-20T12:00:00Z', deletedBy: { kind: 'agent', name: 'GM - Design' } }]);
    presets.deletePreset.mockRejectedValueOnce(new Error("Style 's1' not found"));
    renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Styles' }));
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    expect(trash.fetchTrash).toHaveBeenCalledWith({ kind: 'style', scope: 'global' });
    expect(screen.getByText('Old look')).toBeTruthy();
    expect(screen.getByText(/by GM - Design \(agent\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Neon noir/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Neon noir' }));
    expect(await screen.findByText("Style 's1' not found")).toBeTruthy();
    expect(screen.queryByText(/to Recently deleted/)).toBeNull();
  });

  it('lists again when an agent changes a Style', async () => {
    presets.fetchPresets.mockResolvedValue([style]);
    renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'Styles' }));
    await screen.findByRole('button', { name: /^Neon noir/ });
    presets.fetchPresets.mockResolvedValue([{ ...style, name: 'Neon rain' }]);
    act(() => { for (const handler of socket.handlers) handler({ type: 'storedAssetChanged', kind: 'style', id: 's1', deleted: false }); });
    expect(await screen.findByRole('button', { name: /^Neon rain/ })).toBeTruthy();
  });

  it('Characters and Moodboards keep no Delete in the panel (their Studios have it)', async () => {
    await openTab('Moodboards');
    fireEvent.click(await screen.findByRole('button', { name: /^Warm editorial/ }));
    expect(screen.queryByRole('button', { name: 'Delete Warm editorial' })).toBeNull();
  });
});
