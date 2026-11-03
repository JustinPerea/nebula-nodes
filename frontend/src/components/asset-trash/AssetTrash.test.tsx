import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { RequestFailedError } from '../../lib/errorCopy';
import { RestoreTrashedAsset } from '../nodes/RestoreTrashedAsset';
import { useStoredAssetsStore } from '../../store/storedAssetsStore';
import { publishOpenProject } from '../../lib/currentProject';

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
  publishOpenProject({ id: 'p1', name: 'Project' });
});

afterEach(() => { vi.useRealTimers(); });

describe('RecentlyDeletedAssets', () => {
  it('never loads a deleted Character’s outside thumbnail and says why it shows none', async () => {
    trash.fetchTrash.mockResolvedValue([board({ kind: 'character', id: 'c1', name: 'Old hero',
      thumbnail: 'https://images.example.com/face.png' })]);
    const { container } = render(<RecentlyDeletedAssets kind="character" scope="global" />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    expect(screen.getByText('Old hero')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Image link from outside Nebula')).toBeTruthy();
  });

  it('never loads a deleted board’s outside thumbnail either (Q98)', async () => {
    trash.fetchTrash.mockResolvedValue([board({ id: 'b9', name: 'Old board', thumbnail: 'https://example.com/x.png' })]);
    const { container } = render(<RecentlyDeletedAssets kind="moodboard" scope="global" />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    expect(screen.getByText('Old board')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Image link from outside Nebula')).toBeTruthy();
  });

  it('opens when asked from outside (a Studio line\'s Restore, round 6j), but not for a request made before it mounted', async () => {
    trash.fetchTrash.mockResolvedValue([board()]);
    const view = render(<RecentlyDeletedAssets kind="moodboard" scope="global" openRequest={{ n: 3 }} />);
    const toggle = await screen.findByRole('button', { name: /Recently deleted/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    view.rerender(<RecentlyDeletedAssets kind="moodboard" scope="global" openRequest={{ n: 4 }} />);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Warm editorial')).toBeTruthy();
    // Closed by the person, it stays closed until the next request.
    fireEvent.click(toggle);
    view.rerender(<RecentlyDeletedAssets kind="moodboard" scope="global" openRequest={{ n: 4 }} />);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    view.rerender(<RecentlyDeletedAssets kind="moodboard" scope="global" openRequest={{ n: 5 }} />);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('a request focuses the first asked-for board\'s Restore, the ring only from the keyboard (round 6k, GM r19 3)', async () => {
    trash.fetchTrash.mockResolvedValue([board({ id: 'b1', name: 'Rivers' }), board({ id: 'b2', name: 'Harbor' })]);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const view = render(<RecentlyDeletedAssets kind="moodboard" scope="global" />);
    await screen.findByRole('button', { name: /Recently deleted/ });
    view.rerender(<RecentlyDeletedAssets kind="moodboard" scope="global" openRequest={{ n: 1, focus: ['gone', 'b2', 'b1'], keyboard: true }} />);
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Restore Harbor'));
    expect(focus).toHaveBeenLastCalledWith({ focusVisible: true });
    // Moved on by the person, neither a re-render nor the list reading itself again pulls focus back.
    (document.activeElement as HTMLElement).blur();
    view.rerender(<RecentlyDeletedAssets kind="moodboard" scope="global" openRequest={{ n: 1, focus: ['gone', 'b2', 'b1'], keyboard: true }} />);
    const reads = trash.fetchTrash.mock.calls.length;
    trash.fetchTrash.mockResolvedValue([board({ id: 'b1', name: 'Rivers' }), board({ id: 'b2', name: 'Harbor' }), board({ id: 'b3', name: 'Sea' })]);
    act(() => { ws.handlers.forEach((handler) => handler({ type: 'storedAssetChanged', kind: 'moodboard', id: 'b3' })); });
    await waitFor(() => expect(trash.fetchTrash.mock.calls.length).toBeGreaterThan(reads));
    await screen.findByText('Sea');
    expect(document.activeElement).toBe(document.body);
    view.rerender(<RecentlyDeletedAssets kind="moodboard" scope="global" openRequest={{ n: 2, focus: ['b1'], keyboard: false }} />);
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Restore Rivers'));
    expect(focus).toHaveBeenLastCalledWith({ focusVisible: false });
    // None of them listed here: focus stays.
    (document.activeElement as HTMLElement).blur();
    view.rerender(<RecentlyDeletedAssets kind="moodboard" scope="global" openRequest={{ n: 3, focus: ['elsewhere'] }} />);
    await new Promise((done) => setTimeout(done, 50));
    expect(document.activeElement).toBe(document.body);    focus.mockRestore();
  });

  it('a request that switches scope focuses once that scope\'s list is in, not the old one', async () => {
    trash.fetchTrash.mockImplementation(async ({ scope }: { scope: string }) => (scope === 'project'
      ? [board({ id: 'b1', name: 'Rivers', projectId: 'p1' })] : [board({ id: 'b9', name: 'Old' })]));
    const view = render(<RecentlyDeletedAssets kind="moodboard" scope="global" />);
    await screen.findByRole('button', { name: /Recently deleted/ });
    view.rerender(<RecentlyDeletedAssets kind="moodboard" scope="project" openRequest={{ n: 1, focus: ['b1'], keyboard: true }} />);
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Restore Rivers'));
  });

  it('opened from a Studio line, Empty deletes only the boards it lists (GM r19 4)', async () => {
    const listed = [board({ id: 'b1', name: 'Rivers' }), board({ id: 'b2', name: 'Harbor' })];
    trash.fetchTrash.mockResolvedValue(listed);
    const view = render(<RecentlyDeletedAssets kind="moodboard" scope="global" />);
    await screen.findByRole('button', { name: /Recently deleted/ });
    view.rerender(<RecentlyDeletedAssets kind="moodboard" scope="global" openRequest={{ n: 1, focus: ['b1'] }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Empty' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));
    await waitFor(() => expect(trash.emptyTrash).toHaveBeenCalledWith({ kind: 'moodboard', scope: 'global' }, listed));
  });

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
    expect(screen.getByText(/by GM - Design \(agent\)/)).toBeTruthy();
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

  it('labels an agent from its kind, so a name that looks like "You" never reads as the person', async () => {
    const names = ['You', 'Y\u043eu', 'Y\u200bou', '\u202euoY\u202c', '\uff39\uff4f\uff55'];
    trash.fetchTrash.mockResolvedValue(names.map((name, i) => board({
      id: `b${i}`, name: `Board ${i}`, deletedBy: { kind: 'agent', name } })));
    render(<RecentlyDeletedAssets kind="moodboard" scope="global" />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    names.forEach((name, i) => {
      const row = screen.getByRole('listitem', { name: `Board ${i}` });
      expect(row.textContent).toContain(`by ${name} (agent)`);
      expect(row.textContent).not.toMatch(/by you\b/);
    });
  });

  it('asks before deleting for good, and shows the refusal when the backend says no', async () => {
    trash.fetchTrash.mockResolvedValue([board({ deletedBy: { kind: 'person', name: 'You' } })]);
    // What lib/trash's purgeTrashed throws (apiRequest): a request's own line. Round 3b: the list
    // shows a request's line and never another error's message.
    trash.purgeTrashed.mockRejectedValueOnce(new RequestFailedError("Couldn't delete the board for good.", 403,
      { detail: 'Only the person can do this from the Nebula canvas.' }));
    render(<RecentlyDeletedAssets kind="moodboard" scope="global" />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    expect(screen.getByText(/by you/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
    expect(trash.purgeTrashed).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'This can’t be undone.' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete forever' }).at(-1)!);
    await waitFor(() => expect(trash.purgeTrashed).toHaveBeenCalledWith('moodboard', 'b1'));
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't delete the board for good. Only the person can do this from the Nebula canvas.");
  });

  it('keeps a refusal after the list reads itself again (round 6k: the reload used to wipe it at once)', async () => {
    trash.fetchTrash.mockResolvedValue([board()]);
    trash.restoreTrashed.mockRejectedValueOnce(new RequestFailedError("Couldn't restore the board.", 500, { detail: 'boom' }));
    render(<RecentlyDeletedAssets kind="moodboard" scope="global" />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    const calls = trash.fetchTrash.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Restore Warm editorial' }));
    await waitFor(() => expect(trash.fetchTrash.mock.calls.length).toBeGreaterThan(calls));
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.getByRole('alert').textContent).toContain("Couldn't restore the board.");
    // The next action starts clean.
    fireEvent.click(screen.getByRole('button', { name: 'Restore Warm editorial' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('keeps Styles too, in their own words, and restores one as kind "style"', async () => {
    trash.fetchTrash.mockResolvedValue([board({ kind: 'style', id: 's1', name: 'Neon noir' })]);
    render(<RecentlyDeletedAssets kind="style" scope="global" />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    expect(trash.fetchTrash).toHaveBeenCalledWith({ kind: 'style', scope: 'global' });
    expect(screen.getByRole('region', { name: 'Recently deleted styles' })).toBeTruthy();
    expect(screen.getByText('Deleted styles stay here until you delete them for good.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore Neon noir' }));
    await waitFor(() => expect(trash.restoreTrashed).toHaveBeenCalledWith('style', 's1'));
    await waitFor(() => expect(trash.fetchTrash).toHaveBeenCalledTimes(2)); // listed again after the restore
    // A Style's change elsewhere lists it again; a board's doesn't.
    const calls = trash.fetchTrash.mock.calls.length;
    act(() => ws.handlers.forEach((handler) => handler({ type: 'storedAssetChanged', kind: 'moodboard', id: 'b1', deleted: true })));
    expect(trash.fetchTrash.mock.calls.length).toBe(calls);
    act(() => ws.handlers.forEach((handler) => handler({ type: 'storedAssetChanged', kind: 'style', id: 's2', deleted: true })));
    await waitFor(() => expect(trash.fetchTrash.mock.calls.length).toBe(calls + 1));
  });

  it('empties only the scope it shows', async () => {
    trash.fetchTrash.mockResolvedValue([board(), board({ id: 'b2', name: 'Cold' })]);
    render(<RecentlyDeletedAssets kind="character" scope="project" />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Empty' }));
    expect(screen.getByRole('group', { name: 'Delete all 2 characters for good?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));
    await waitFor(() => expect(trash.emptyTrash).toHaveBeenCalledWith(
      { kind: 'character', scope: 'project', projectId: 'p1' },
      [expect.objectContaining({ id: 'b1' }), expect.objectContaining({ id: 'b2' })],
    ));
  });
});

// Round 6l: what a Studio's kept edits put at stake (GM r21 Q2), and the review 10 fixes.
describe('RecentlyDeletedAssets, round 6l', () => {
  const lostToo = (items: readonly TrashedItem[]) => {
    const kept = items.filter((item) => item.id === 'b1' || item.id === 'b2').map((item) => `“${item.name}”`);
    return kept.length ? { text: `Your unsaved ${kept.length === 1 ? 'change' : 'changes'} to ${kept.join(' and ')} will be lost too.`, title: kept.join(' and ') } : null;
  };

  it('Delete forever: the confirm adds what it loses too; once done, it reports the id', async () => {
    trash.fetchTrash.mockResolvedValue([board({ id: 'b1', name: 'Rivers' }), board({ id: 'b9', name: 'Other' })]);
    const onPurged = vi.fn();
    render(<RecentlyDeletedAssets kind="moodboard" scope="global" atStake={lostToo} onPurged={onPurged} />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete forever' })[0]);
    const group = screen.getByRole('group', { name: 'This can’t be undone. Your unsaved change to “Rivers” will be lost too.' });
    expect(group.querySelector('.asset-trash__confirm-prompt')?.getAttribute('title')).toBe('“Rivers”');
    fireEvent.click(within(group).getByRole('button', { name: 'Delete forever' }));
    await waitFor(() => expect(onPurged).toHaveBeenCalledWith(['b1']));
    // Another row with nothing at stake: the confirm as before.
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete forever' })[1]);
    expect(screen.getByRole('group', { name: 'This can’t be undone.' })).toBeTruthy();
  });

  it('Empty: the confirm names what it loses; a refused one reports nothing', async () => {
    trash.fetchTrash.mockResolvedValue([board({ id: 'b1', name: 'Rivers' }), board({ id: 'b2', name: 'Harbor' }), board({ id: 'b9', name: 'Other' })]);
    trash.emptyTrash.mockRejectedValueOnce(new RequestFailedError("Couldn't empty Recently deleted.", 500, { detail: 'boom' }));
    const onPurged = vi.fn();
    render(<RecentlyDeletedAssets kind="moodboard" scope="global" atStake={lostToo} onPurged={onPurged} />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Empty' }));
    expect(screen.getByRole('group', { name: 'Delete all 3 boards for good? Your unsaved changes to “Rivers” and “Harbor” will be lost too.' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));
    await screen.findByRole('alert');
    expect(onPurged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Empty' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete all' }));
    await waitFor(() => expect(onPurged).toHaveBeenCalledWith(['b1', 'b2', 'b9']));
  });

  it('starts open when asked to (a Studio\'s several-board Restore, review 10 NIT-3)', async () => {
    trash.fetchTrash.mockResolvedValue([board()]);
    render(<RecentlyDeletedAssets kind="moodboard" scope="global" defaultOpen />);
    expect((await screen.findByRole('button', { name: /Recently deleted/ })).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Warm editorial')).toBeTruthy();
  });

  it('a refusal goes with a scope or project switch (review 10 NIT-2)', async () => {
    trash.fetchTrash.mockResolvedValue([board()]);
    trash.restoreTrashed.mockRejectedValueOnce(new RequestFailedError("Couldn't restore the board.", 500, { detail: 'boom' }));
    const view = render(<RecentlyDeletedAssets kind="moodboard" scope="global" />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore Warm editorial' }));
    await screen.findByRole('alert');
    view.rerender(<RecentlyDeletedAssets kind="moodboard" scope="project" />);
    await screen.findByRole('button', { name: /Recently deleted/ });
    expect(screen.queryByRole('alert')).toBeNull();
    // A project switch too.
    trash.restoreTrashed.mockRejectedValueOnce(new RequestFailedError("Couldn't restore the board.", 500, { detail: 'boom' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore Warm editorial' }));
    await screen.findByRole('alert');
    act(() => { publishOpenProject({ id: 'p2', name: 'Other project' }); });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('an action\'s refusal shows over a later failed load (V16)', async () => {
    trash.fetchTrash.mockResolvedValueOnce([board()]).mockRejectedValue(new RequestFailedError("Couldn't load Recently deleted.", 500, { detail: 'x' }));
    trash.restoreTrashed.mockRejectedValueOnce(new RequestFailedError("Couldn't restore the board.", 500, { detail: 'boom' }));
    render(<RecentlyDeletedAssets kind="moodboard" scope="global" />);
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore Warm editorial' }));
    await waitFor(() => expect(trash.fetchTrash).toHaveBeenCalledTimes(2));
    await new Promise((done) => setTimeout(done, 30));
    expect(screen.getByRole('alert').textContent).toContain("Couldn't restore the board.");
    expect(screen.getByRole('alert').textContent).not.toContain('load');
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
