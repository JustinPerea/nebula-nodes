import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TrashedItem } from '../../lib/trash';

const trash = vi.hoisted(() => ({
  fetchTrash: vi.fn(),
  restoreTrashed: vi.fn(),
  purgeTrashed: vi.fn(),
  emptyTrash: vi.fn(),
}));
const api = vi.hoisted(() => ({ lookupStoredAsset: vi.fn() }));

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8822${url}` }));
vi.mock('../../lib/trash', async (importOriginal) => ({ ...(await importOriginal<object>()), ...trash }));
vi.mock('../../lib/api', () => api);
const ws = vi.hoisted(() => ({ handlers: new Set<(event: unknown) => void>() }));
vi.mock('../../lib/wsClient', () => ({
  wsClient: { subscribe: (handler: (event: unknown) => void) => { ws.handlers.add(handler); return () => ws.handlers.delete(handler); } },
}));

import { RecentlyDeletedAssets, UndoDeleteToast, UNDO_VISIBLE_MS } from './AssetTrash';
import { RestoreTrashedAsset } from '../nodes/RestoreTrashedAsset';
import { useStoredAssetsStore } from '../../store/storedAssetsStore';

const board = (overrides: Partial<TrashedItem> = {}): TrashedItem => ({
  kind: 'moodboard', id: 'b1', name: 'Warm editorial', thumbnail: '/api/outputs/a.png', projectId: null,
  deletedAt: '2026-10-18T12:00:00Z', deletedBy: { kind: 'agent', name: 'GM - Design' }, ...overrides,
});

beforeEach(() => {
  Object.values(trash).forEach((mock) => mock.mockReset());
  api.lookupStoredAsset.mockReset();
  trash.restoreTrashed.mockResolvedValue(undefined);
  trash.purgeTrashed.mockResolvedValue(undefined);
  trash.emptyTrash.mockResolvedValue(undefined);
});

afterEach(() => { vi.useRealTimers(); });

describe('RecentlyDeletedAssets', () => {
  it('stays hidden while nothing is in the trash', async () => {
    trash.fetchTrash.mockResolvedValue([]);
    const { container } = render(<RecentlyDeletedAssets kind="moodboard" scope="global" />);
    await waitFor(() => expect(trash.fetchTrash).toHaveBeenCalledWith({ kind: 'moodboard', scope: 'global' }));
    expect(container.textContent).toBe('');
  });

  it('lists deleted boards with who deleted them, and restores one', async () => {
    trash.fetchTrash.mockResolvedValueOnce([board()]).mockResolvedValue([]);
    const onRestored = vi.fn();
    render(<RecentlyDeletedAssets kind="moodboard" scope="global" onRestored={onRestored} />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    expect(screen.getByText('Warm editorial')).toBeTruthy();
    expect(screen.getByText(/by GM - Design/)).toBeTruthy();
    expect(screen.getByText('Deleted boards stay here until you delete them for good.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore Warm editorial' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(board()));
    expect(trash.restoreTrashed).toHaveBeenCalledWith('moodboard', 'b1');
    expect(trash.purgeTrashed).not.toHaveBeenCalled();
  });

  it('lists again when a board is deleted elsewhere, and tells the library to list again', async () => {
    trash.fetchTrash.mockResolvedValueOnce([]).mockResolvedValue([board()]);
    const onTrashChanged = vi.fn();
    render(<RecentlyDeletedAssets kind="moodboard" scope="global" onTrashChanged={onTrashChanged} />);
    await waitFor(() => expect(trash.fetchTrash).toHaveBeenCalledTimes(1));
    expect(onTrashChanged).not.toHaveBeenCalled();
    // An agent deletes a board: the backend broadcasts storedAssetChanged.
    act(() => ws.handlers.forEach((handler) => handler({ type: 'storedAssetChanged', kind: 'character', id: 'c1', deleted: true })));
    act(() => ws.handlers.forEach((handler) => handler({ type: 'storedAssetChanged', kind: 'moodboard', id: 'b1', deleted: true })));
    expect(await screen.findByRole('button', { name: /Recently deleted/ })).toBeTruthy();
    expect(trash.fetchTrash).toHaveBeenCalledTimes(2);
    expect(onTrashChanged).toHaveBeenCalledTimes(1);
    // A save that changes nothing in the trash doesn't make the library list again.
    act(() => ws.handlers.forEach((handler) => handler({ type: 'storedAssetChanged', kind: 'moodboard', id: 'b2', deleted: false })));
    await waitFor(() => expect(trash.fetchTrash).toHaveBeenCalledTimes(3));
    expect(onTrashChanged).toHaveBeenCalledTimes(1);
  });

  it('asks before deleting for good, and shows the refusal when the backend says no', async () => {
    trash.fetchTrash.mockResolvedValue([board({ deletedBy: { kind: 'person', name: 'You' } })]);
    trash.purgeTrashed.mockRejectedValueOnce(new Error('Only the person can do this from the Nebula canvas.'));
    render(<RecentlyDeletedAssets kind="moodboard" scope="global" />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    expect(screen.getByText(/by you/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    expect(trash.purgeTrashed).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'This can’t be undone.' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete forever' }).at(-1)!);
    await waitFor(() => expect(trash.purgeTrashed).toHaveBeenCalledWith('moodboard', 'b1'));
    expect((await screen.findByRole('alert')).textContent).toContain('Only the person');
  });

  it('empties only the scope it shows', async () => {
    trash.fetchTrash.mockResolvedValue([board(), board({ id: 'b2', name: 'Cold' })]);
    render(<RecentlyDeletedAssets kind="character" scope="project" />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Empty' }));
    expect(screen.getByRole('group', { name: 'Delete all 2 characters for good?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));
    await waitFor(() => expect(trash.emptyTrash).toHaveBeenCalledWith(
      { kind: 'character', scope: 'project' },
      [expect.objectContaining({ id: 'b1' }), expect.objectContaining({ id: 'b2' })],
    ));
  });
});

describe('UndoDeleteToast', () => {
  it('offers Undo and goes away on its own', () => {
    vi.useFakeTimers();
    const onUndo = vi.fn();
    const onDismiss = vi.fn();
    render(<UndoDeleteToast name="Warm editorial" onUndo={onUndo} onDismiss={onDismiss} />);
    expect(screen.getByRole('status').textContent).toContain('Moved “Warm editorial” to Recently deleted');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(UNDO_VISIBLE_MS); });
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('a card whose asset is in the trash', () => {
  it('reads it as trashed, not missing, and Restore brings it back', async () => {
    api.lookupStoredAsset.mockResolvedValueOnce({ status: 'trashed', trashed: board() });
    await useStoredAssetsStore.getState().ensure('moodboard', 'b1');
    const entry = useStoredAssetsStore.getState().entries['moodboard:b1'];
    expect(entry.status).toBe('trashed');
    expect(entry.summary?.name).toBe('Warm editorial');

    api.lookupStoredAsset.mockResolvedValueOnce({ status: 'ready', asset: {
      id: 'b1', name: 'Warm editorial', thumbnail: '', images: [], mode: 'look' } });
    render(<RestoreTrashedAsset kind="moodboard" id="b1" className="moodboard-node__open" />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(useStoredAssetsStore.getState().entries['moodboard:b1'].status).toBe('ready'));
    expect(trash.restoreTrashed).toHaveBeenCalledWith('moodboard', 'b1');
  });

  it('fetches again when the backend says it was deleted', async () => {
    api.lookupStoredAsset.mockResolvedValueOnce({ status: 'ready', asset: {
      id: 'c1', name: 'Rina', thumbnail: '', referenceViews: [] } });
    await useStoredAssetsStore.getState().ensure('character', 'c1');
    api.lookupStoredAsset.mockResolvedValueOnce({ status: 'trashed', trashed: board({ kind: 'character', id: 'c1', name: 'Rina' }) });
    useStoredAssetsStore.getState().applyChange({ kind: 'character', id: 'c1', deleted: true });
    await waitFor(() => expect(useStoredAssetsStore.getState().entries['character:c1'].status).toBe('trashed'));
  });
});
