/**
 * PR #199 round 26: the kept canvas's project chooser deletes the way the app deletes (the Undo toast, no
 * confirm; Projects home's Delete is the same), in the app's modal, with the facts the project list shows;
 * and the refusal line follows the live project count, saving once by itself when deleting made room.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}),
  disconnect: vi.fn(), send: vi.fn(), setViewing: vi.fn(), notePersonAct: vi.fn(), setKeptEdits: vi.fn() } }));

import { regionNoticesReady } from './helpers/regionNoticesReady';
import { KeptEditsNotice } from '../src/components/projects/KeptEditsNotice';
import { keepCanvasLocally, releaseKeptCanvas, useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';
import { resetKeptCanvasForTests } from '../src/lib/keptCanvas';
import { keptLimitLine, KEPT_ROOM_LINE } from '../src/components/projects/restoreCopyCore';

beforeAll(regionNoticesReady);

const summary = (id: string, name: string, nodeCount = 3, edgeCount = 1) => ({ id, name, createdAt: '2026-10-09T10:00:00Z',
  updatedAt: '2026-10-09T10:00:00Z', lastOpenedAt: null, nodeCount, edgeCount, thumbnail: null });
const initialProject = useProjectStore.getState();
const HEAD = 'Nebula couldn’t save your edits as a project because';
const restore = vi.fn(async () => {});
const emptyTrash = vi.fn(async () => {});
const saveKeptEdits = vi.fn(async () => {
  const now = useProjectStore.getState().keptEdits!;
  useProjectStore.setState({ keptEdits: { ...now, saving: true, error: null } });
});
// The store's own remove, minus the network: the project leaves the list, and lastDeleted names it.
const remove = vi.fn(async (id: string) => {
  const gone = useProjectStore.getState().projects.find((project) => project.id === id)!;
  useProjectStore.setState((state) => ({ projects: state.projects.filter((project) => project.id !== id), trash: [{ ...gone, deletedAt: '2026-10-09T10:00:00Z', purgeAt: '2026-11-09T10:00:00Z' }, ...state.trash], lastDeleted: { id, name: gone.name } }) as never);
});

function kept(limitCounts: { count: number; limit: number; deletes: number | null } | null, extra: Record<string, unknown> = {}, projects = [summary('a', 'Alpha'), summary('b', 'Beta')]) {
  const line = limitCounts ? keptLimitLine(limitCounts.count, limitCounts.limit, limitCounts.deletes) : `${HEAD} the project list is full. Delete a project and remove it from Recently deleted, and Nebula saves your edits.`;
  useProjectStore.setState({ screen: 'workspace', projects, trash: [], lastDeleted: null,
    keptEdits: { sourceId: 'gone', sourceName: 'Gone', lead: null, saving: false, error: line, chooseToDelete: limitCounts ? 'projects' : 'storage', limitCounts, ...extra },
    remove, restore, emptyTrash, saveKeptEdits } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetKeptCanvasForTests();
  useGraphStore.setState({ nodes: [], edges: [], isExecuting: false, keptUndo: [], keptRedo: [] });
  keepCanvasLocally();
});
afterEach(() => {
  cleanup();
  releaseKeptCanvas();
  resetKeptCanvasForTests();
  useProjectStore.setState(initialProject, true);
});

const open = async () => {
  const button = screen.getByRole('button', { name: 'Choose a project to delete' });
  button.focus();
  fireEvent.click(button);
  return { button, dialog: await screen.findByRole('dialog', { name: 'Choose a project to delete' }) };
};

describe('the chooser is the app\'s modal and deletes the app\'s way', () => {
  it('opens in the app\'s portal with its scrim, and rows show what Projects shows', async () => {
    kept({ count: 2, limit: 1, deletes: 2 });
    render(<KeptEditsNotice />);
    const { dialog } = await open();
    const scrim = dialog.parentElement!;
    expect(scrim.className).toContain('prompt-dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(scrim.closest('[data-modal-layer]')?.parentElement).toBe(document.body);
    const row = within(dialog).getAllByRole('listitem')[0];
    expect(row.textContent).toMatch(/Alpha/);
    expect(row.textContent).toMatch(/Edited Oct 9, 2026/);
    expect(row.textContent).toMatch(/3 nodes · 1 connection/);
  });

  it('Delete moves the project to Recently deleted with the app\'s Undo toast, and Undo restores it', async () => {
    kept({ count: 2, limit: 1, deletes: 2 });
    render(<KeptEditsNotice />);
    const { dialog } = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Beta' }));
    expect(remove).toHaveBeenCalledWith('b');
    const toast = await screen.findByText('Moved “Beta” to Recently deleted');
    fireEvent.click(within(toast.parentElement as HTMLElement).getByRole('button', { name: 'Undo' }));
    expect(restore).toHaveBeenCalledWith('b', 'undo');
  });

  it('Escape closes it and focus returns to [Choose a project to delete]', async () => {
    kept({ count: 2, limit: 1, deletes: 2 });
    render(<KeptEditsNotice />);
    const { button } = await open();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });
});

describe('the refusal line follows the live list', () => {
  it('updates the moment a delete lands, and says so when there is room', async () => {
    kept({ count: 2, limit: 1, deletes: 2 }, {}, [summary('a', 'Alpha'), summary('b', 'Beta')]);
    render(<KeptEditsNotice />);
    expect(screen.getByRole('alert').textContent).toBe(`${HEAD} you have 2 projects, over the limit of 1. Delete 2 projects, and Nebula saves your edits.`);
    act(() => { useProjectStore.setState({ projects: [summary('a', 'Alpha')] }); });
    expect(screen.getByRole('alert').textContent).toBe(`${HEAD} you’ve reached the limit of 1 project. Delete 1 project, and Nebula saves your edits.`);
    expect(saveKeptEdits).not.toHaveBeenCalled();
    act(() => { useProjectStore.setState({ projects: [] }); });
    expect(saveKeptEdits).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toBe(KEPT_ROOM_LINE);
    expect(screen.queryByRole('button', { name: 'Choose a project to delete' })).toBeNull();
  });

  it('saves by itself only once per refusal; a refusal after it stays, and the person\'s Save starts over', async () => {
    kept({ count: 1, limit: 1, deletes: 1 }, {}, [summary('a', 'Alpha')]);
    render(<KeptEditsNotice />);
    act(() => { useProjectStore.setState({ projects: [] }); });
    expect(saveKeptEdits).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().keptEdits?.autoRetried).toBe(true);
    // The retry was refused again (the flow keeps autoRetried): deleting more doesn't retry by itself.
    act(() => { const now = useProjectStore.getState().keptEdits!; useProjectStore.setState({ projects: [summary('z', 'Zed')], keptEdits: { ...now, saving: false, error: keptLimitLine(1, 1) } }); });
    act(() => { useProjectStore.setState({ projects: [] }); });
    expect(saveKeptEdits).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector('[data-kept-save]') as HTMLElement);
    expect(saveKeptEdits).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().keptEdits?.autoRetried).toBe(false);
  });

  it('the storage-cap line stays until Recently deleted gets smaller, then it saves once', async () => {
    kept(null, {}, [summary('a', 'Alpha')]);
    useProjectStore.setState({ trash: [{ ...summary('t', 'Old'), deletedAt: '2026-10-01T00:00:00Z', purgeAt: '2026-10-31T00:00:00Z' }] } as never);
    render(<KeptEditsNotice />);
    expect(saveKeptEdits).not.toHaveBeenCalled();
    // A Delete adds to Recently deleted: nothing was freed.
    act(() => { useProjectStore.setState({ projects: [], trash: [...useProjectStore.getState().trash, { ...summary('a', 'Alpha'), deletedAt: '2026-10-09T00:00:00Z', purgeAt: '2026-11-09T00:00:00Z' }] } as never); });
    expect(saveKeptEdits).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('the project list is full');
    act(() => { useProjectStore.setState({ trash: [] }); });
    expect(saveKeptEdits).toHaveBeenCalledTimes(1);
  });

  it('names how many projects: "Delete 1 project" and "Delete 2 projects"', () => {
    expect(keptLimitLine(1, 1)).toBe(`${HEAD} you’ve reached the limit of 1 project. Delete 1 project, and Nebula saves your edits.`);
    expect(keptLimitLine(2, 1)).toBe(`${HEAD} you have 2 projects, over the limit of 1. Delete 2 projects, and Nebula saves your edits.`);
  });
});
