/**
 * PR #199 round 27 check: with the real NoticeRegion, a Delete that makes no room keeps the chooser open and
 * its Undo toast stays outside every inert or aria-hidden subtree, so the person can press Undo (the round 26
 * test reads the toast with `hidden: true`, which would pass even if it were inert). Also: a chooser failure
 * is cleared when the chooser closes, so no stale line waits for Projects home.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}),
  disconnect: vi.fn(), send: vi.fn(), setViewing: vi.fn(), notePersonAct: vi.fn(), setKeptEdits: vi.fn() } }));
import { regionNoticesReady } from './helpers/regionNoticesReady';
import { NoticeRegion } from '../src/components/NoticeRegion';
import { keepCanvasLocally, releaseKeptCanvas, useGraphStore } from '../src/store/graphStore';
import { useProjectStore } from '../src/store/projectStore';
import { resetKeptCanvasForTests } from '../src/lib/keptCanvas';
beforeAll(regionNoticesReady);
const summary = (id: string, name: string) => ({ id, name, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z', lastOpenedAt: null, nodeCount: 3, edgeCount: 1, thumbnail: null });
const trashed = (id: string, name: string) => ({ ...summary(id, name), deletedAt: '2026-10-09T10:00:00Z', purgeAt: '2026-11-09T10:00:00Z' });
const restore = vi.fn(async () => {});
const remove = vi.fn(async (id: string) => {
  const gone = useProjectStore.getState().projects.find((p) => p.id === id)!;
  useProjectStore.setState((s) => ({ projects: s.projects.filter((p) => p.id !== id), trash: [trashed(id, gone.name), ...s.trash], lastDeleted: { id, name: gone.name } }) as never);
});
const initial = useProjectStore.getState();
beforeEach(() => { resetKeptCanvasForTests(); useGraphStore.setState({ nodes: [], edges: [], isExecuting: false, keptUndo: [], keptRedo: [] }); keepCanvasLocally(); });
afterEach(() => { cleanup(); releaseKeptCanvas(); resetKeptCanvasForTests(); useProjectStore.setState(initial, true); });
it('the Undo toast is live above the open chooser in the real notice region (a delete that makes no room)', async () => {
  const limitCounts = { count: 3, limit: 2, deletes: 1 };
  useProjectStore.setState({ screen: 'workspace', projects: [summary('a','Alpha'), summary('b','Beta'), summary('c','Gamma')], trash: [], lastDeleted: null, activeProject: null, error: null,
    keptEdits: { sourceId: 'gone', sourceName: 'Gone', lead: null, saving: false, error: 'limit', chooseToDelete: 'projects', limitCounts }, remove, restore } as never);
  render(<NoticeRegion screen="canvas" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Choose a project to delete' }));
  const dialog = await screen.findByRole('dialog', { name: 'Choose a project to delete' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Beta' }));
  const toastText = await screen.findByText('Moved “Beta” to Recently deleted');
  expect(screen.queryByRole('dialog')).not.toBeNull(); // chooser still open
  const undo = within(toastText.parentElement as HTMLElement).getByRole('button', { name: 'Undo' });
  expect(undo.closest('[inert],[aria-hidden="true"]')).toBeNull();
  fireEvent.click(undo);
  expect(restore).toHaveBeenCalledWith('b', 'undo');
});

it('clears its own failure line when the chooser closes', async () => {
  useProjectStore.setState({ screen: 'workspace', projects: [summary('a','Alpha'), summary('b','Beta')], trash: [], lastDeleted: null, activeProject: null, error: null,
    keptEdits: { sourceId: 'gone', sourceName: 'Gone', lead: null, saving: false, error: 'limit', chooseToDelete: 'projects', limitCounts: { count: 2, limit: 1, deletes: 1 } } } as never);
  render(<NoticeRegion screen="canvas" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Choose a project to delete' }));
  const dialog = await screen.findByRole('dialog', { name: 'Choose a project to delete' });
  act(() => { useProjectStore.setState({ error: 'Couldn’t delete the project. It changed in another tab.' }); });
  expect(within(dialog).getByRole('alert').textContent).toContain('Couldn’t delete the project.');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(useProjectStore.getState().error).toBeNull();
});
