/**
 * PR #199 round 27 (final review): the chooser leaves no way to delete the kept canvas's own project (its row
 * is disabled with the reason); the Delete that makes room keeps its Undo toast after the chooser closes and
 * the automatic save waits for it; the chooser's own failures show in it; Escape disarms Empty first and
 * Cancel waits while busy.
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
import { keptLimitLine, KEPT_ROOM_LINE, KEPT_ROOM_WAIT_LINE, KEPT_SOURCE_DELETE_LINE } from '../src/components/projects/restoreCopyCore';
import { UNDO_VISIBLE_MS } from '../src/components/projects/toastTiming';

beforeAll(regionNoticesReady);

const summary = (id: string, name: string) => ({ id, name, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
  lastOpenedAt: null, nodeCount: 3, edgeCount: 1, thumbnail: null });
const initialProject = useProjectStore.getState();
const trashed = (id: string, name: string) => ({ ...summary(id, name), deletedAt: '2026-10-09T10:00:00Z', purgeAt: '2026-11-09T10:00:00Z' });
const saveKeptEdits = vi.fn(async () => {
  const now = useProjectStore.getState().keptEdits!;
  useProjectStore.setState({ keptEdits: { ...now, saving: true, error: null } });
});
const emptyTrash = vi.fn(async () => {});
// The store's own remove and restore, minus the network.
const remove = vi.fn(async (id: string) => {
  const gone = useProjectStore.getState().projects.find((project) => project.id === id)!;
  useProjectStore.setState((state) => ({ projects: state.projects.filter((project) => project.id !== id), trash: [trashed(id, gone.name), ...state.trash], lastDeleted: { id, name: gone.name } }) as never);
});
const restore = vi.fn(async (id: string) => {
  const back = useProjectStore.getState().trash.find((entry) => entry.id === id)!;
  useProjectStore.setState((state) => ({ projects: [...state.projects, summary(id, back.name)], trash: state.trash.filter((entry) => entry.id !== id), lastDeleted: null }) as never);
});

function kept(extra: Record<string, unknown> = {}, projects = [summary('a', 'Alpha'), summary('b', 'Beta')], limitCounts = { count: 2, limit: 2, deletes: 1 }) {
  useProjectStore.setState({ screen: 'workspace', projects, trash: [], lastDeleted: null, activeProject: null, error: null,
    keptEdits: { sourceId: 'gone', sourceName: 'Gone', lead: null, saving: false, error: keptLimitLine(limitCounts.count, limitCounts.limit, limitCounts.deletes),
      chooseToDelete: 'projects', limitCounts, ...extra },
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
  vi.useRealTimers();
  releaseKeptCanvas();
  resetKeptCanvasForTests();
  useProjectStore.setState(initialProject, true);
});

const open = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Choose a project to delete' }));
  return screen.findByRole('dialog', { name: 'Choose a project to delete' });
};

describe('the kept canvas\'s own project in the chooser', () => {
  it('shows disabled with its reason, and a press does nothing; other rows still delete', async () => {
    kept({ sourceId: 'b' });
    render(<KeptEditsNotice />);
    const dialog = await open();
    const delBeta = within(dialog).getByRole('button', { name: 'Delete Beta' }) as HTMLButtonElement;
    expect(delBeta.disabled).toBe(true);
    expect(within(dialog).getAllByRole('listitem')[1].textContent).toContain(KEPT_SOURCE_DELETE_LINE);
    fireEvent.click(delBeta);
    expect(remove).not.toHaveBeenCalled();
    const delAlpha = within(dialog).getByRole('button', { name: 'Delete Alpha' }) as HTMLButtonElement;
    expect(delAlpha.disabled).toBe(false);
    expect(within(dialog).getAllByRole('listitem')[0].textContent).not.toContain(KEPT_SOURCE_DELETE_LINE);
  });

  it('the active project reads the same (a restore leaves an older copy of it active)', async () => {
    kept({}, [summary('a', 'Alpha'), summary('b', 'Beta')]);
    useProjectStore.setState({ activeProject: summary('a', 'Alpha') as never });
    render(<KeptEditsNotice />);
    const dialog = await open();
    expect((within(dialog).getByRole('button', { name: 'Delete Alpha' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the Delete that makes room keeps its Undo, and the save waits for it', () => {
  it('toast outlives the chooser; no save before the window ends; the save runs after', async () => {
    kept();
    render(<KeptEditsNotice />);
    const dialog = await open();
    vi.useFakeTimers();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Beta' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Moved “Beta” to Recently deleted')).not.toBeNull();
    expect(saveKeptEdits).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(KEPT_ROOM_WAIT_LINE);
    await act(async () => { vi.advanceTimersByTime(UNDO_VISIBLE_MS - 500); });
    expect(saveKeptEdits).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(useProjectStore.getState().lastDeleted).toBeNull();
    expect(saveKeptEdits).toHaveBeenCalledTimes(1);
  });

  it('Undo inside the window brings the project back with no save, and the line returns to the refusal', async () => {
    kept();
    render(<KeptEditsNotice />);
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Beta' }));
    const toast = await screen.findByText('Moved “Beta” to Recently deleted');
    fireEvent.click(within(toast.parentElement as HTMLElement).getByRole('button', { name: 'Undo' }));
    await act(async () => { await Promise.resolve(); });
    expect(restore).toHaveBeenCalledWith('b', 'undo');
    expect(useProjectStore.getState().projects.map((project) => project.id)).toContain('b');
    expect(saveKeptEdits).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(keptLimitLine(2, 2, 1));
    expect(screen.queryByRole('button', { name: 'Choose a project to delete' })).not.toBeNull();
  });

  it('[Save as a project] pressed sooner does not wait', async () => {
    kept();
    render(<KeptEditsNotice />);
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Beta' }));
    await screen.findByText('Moved “Beta” to Recently deleted');
    expect(saveKeptEdits).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-kept-save]') as HTMLElement);
    expect(saveKeptEdits).toHaveBeenCalledTimes(1);
  });

  it('without an Undo showing, room saves at once and says so', async () => {
    kept();
    render(<KeptEditsNotice />);
    act(() => { useProjectStore.setState({ projects: [summary('a', 'Alpha')] }); });
    expect(saveKeptEdits).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toBe(KEPT_ROOM_LINE);
  });
});

describe('the chooser says its own failures', () => {
  it('a refused Delete shows its line in the dialog, in the store\'s words', async () => {
    const line = 'Couldn’t delete the project. It changed since this tab loaded it.';
    kept();
    const refuse = vi.fn(async () => { useProjectStore.setState({ error: line }); });
    useProjectStore.setState({ remove: refuse } as never);
    render(<KeptEditsNotice />);
    const dialog = await open();
    expect(dialog.querySelector('[data-kept-chooser-error]')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Alpha' }));
    await waitFor(() => expect(dialog.querySelector('[data-kept-chooser-error]')?.textContent).toBe(line));
    expect(within(dialog).getByRole('alert').textContent).toBe(line);
  });

  it('an older error is not shown when the chooser opens, and the kept update line is never drawn here', async () => {
    kept();
    useProjectStore.setState({ error: 'Couldn’t rename the project. Old.' });
    render(<KeptEditsNotice />);
    const dialog = await open();
    expect(dialog.querySelector('[data-kept-chooser-error]')).toBeNull();
  });
});

describe('Empty Recently deleted in the chooser matches the app\'s', () => {
  const armed = async () => {
    kept({ chooseToDelete: 'storage', limitCounts: null }, [summary('a', 'Alpha')]);
    useProjectStore.setState({ trash: [trashed('t', 'Old')] } as never);
    render(<KeptEditsNotice />);
    const dialog = await open();
    fireEvent.click(dialog.querySelector('[data-kept-empty]') as HTMLElement);
    expect(dialog.querySelector('[data-kept-empty-confirm]')).not.toBeNull();
    return dialog;
  };
  const escape = () => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

  it('Escape disarms first, and a second Escape closes the dialog', async () => {
    const dialog = await armed();
    escape();
    expect(dialog.querySelector('[data-kept-empty-confirm]')).toBeNull();
    expect(dialog.querySelector('[data-kept-empty]')).not.toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeNull();
    escape();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(emptyTrash).not.toHaveBeenCalled();
  });

  it('Cancel is disabled while the store is busy', async () => {
    const dialog = await armed();
    expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
    act(() => { useProjectStore.setState({ busy: true }); });
    expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
