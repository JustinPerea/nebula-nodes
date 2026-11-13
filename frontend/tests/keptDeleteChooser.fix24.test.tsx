/**
 * PR #199 round 25, GM r24 (b): the kept save the project limit or the
 * storage cap refused is fixed by deleting, and kept mode locks Projects, so
 * the kept notice offers [Choose a project to delete] beside the refusal's
 * line, and its dialog lists the projects (each with Delete) and, when
 * Recently deleted has items, [Empty Recently deleted].
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
import { keptLimitLine, keptStorageFullLine, CHOOSE_A_PROJECT_TO_DELETE } from '../src/components/projects/restoreCopyCore';

beforeAll(regionNoticesReady);

const summary = (id: string, name: string) => ({ id, name, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z',
  lastOpenedAt: null, nodeCount: 0, edgeCount: 0, thumbnail: null });
const AT_LIMIT = 'Nebula couldn’t save your edits as a project because you’ve reached the limit of 3 projects. Delete one, and Nebula saves your edits.';
const STORAGE = 'Nebula couldn’t save your edits as a project because the project list is full. Delete a project and remove it from Recently deleted, and Nebula saves your edits.';
const initialProject = useProjectStore.getState();
const remove = vi.fn(async () => {});
const emptyTrash = vi.fn(async () => {});

function keptWith(error: string | null, chooseToDelete: 'projects' | 'storage' | null, extra: Record<string, unknown> = {}) {
  useProjectStore.setState({ screen: 'workspace', projects: [summary('a', 'Alpha'), summary('b', 'Beta'), summary('c', 'Gamma')], trash: [],
    keptEdits: { sourceId: 'gone', sourceName: 'Gone', lead: null, saving: false, error, chooseToDelete }, remove, emptyTrash, ...extra } as never);
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

describe('GM r24 (b): the lines, verbatim', () => {
  it('the three kept-save refusals match', () => {
    expect(keptLimitLine(3, 3)).toBe(AT_LIMIT);
    expect(keptLimitLine(2, 1)).toBe('Nebula couldn’t save your edits as a project because you have 2 projects, over the limit of 1. Delete 2 projects, and Nebula saves your edits.');
    expect(keptLimitLine(501, 500, 2)).toBe('Nebula couldn’t save your edits as a project because you have 501 projects, over the limit of 500. Delete 2 projects, and Nebula saves your edits.');
    expect(keptStorageFullLine()).toBe(STORAGE);
    // No second "Nebula" before "project list", and no "Nebula will".
    for (const line of [AT_LIMIT, STORAGE]) expect(line.match(/Nebula/g)).toHaveLength(2);
  });
  it('the button is named as GM named it', () => {
    expect(CHOOSE_A_PROJECT_TO_DELETE).toBe('Choose a project to delete');
  });
});

describe('GM r24 (b): [Choose a project to delete] on the project-limit and storage-cap notices', () => {
  it('shows beside the project-limit line and the storage-cap line, and on no other kept notice', () => {
    keptWith(AT_LIMIT, 'projects');
    const { rerender } = render(<KeptEditsNotice />);
    expect(screen.getByRole('button', { name: 'Choose a project to delete' })).toBeTruthy();
    useProjectStore.setState({ keptEdits: { sourceId: 'gone', sourceName: 'Gone', lead: null, saving: false, error: STORAGE, chooseToDelete: 'storage' } });
    rerender(<KeptEditsNotice />);
    expect(screen.getByRole('button', { name: 'Choose a project to delete' })).toBeTruthy();
    // Another refusal's line (no chooser), and no line at all.
    useProjectStore.setState({ keptEdits: { sourceId: 'gone', sourceName: 'Gone', lead: null, saving: false, error: 'Nebula couldn’t save your edits. Try again.', chooseToDelete: null } });
    rerender(<KeptEditsNotice />);
    expect(screen.queryByRole('button', { name: 'Choose a project to delete' })).toBeNull();
    useProjectStore.setState({ keptEdits: { sourceId: 'gone', sourceName: 'Gone', lead: null, saving: false, error: null, chooseToDelete: 'projects' } });
    rerender(<KeptEditsNotice />);
    expect(screen.queryByRole('button', { name: 'Choose a project to delete' })).toBeNull();
  });

  it('opens a dialog of the projects, each with its Delete, and Delete goes to the store', async () => {
    keptWith(AT_LIMIT, 'projects');
    render(<KeptEditsNotice />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose a project to delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose a project to delete' });
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getByRole('button').getAttribute('aria-label'))).toEqual(['Delete Alpha', 'Delete Beta', 'Delete Gamma']);
    // Nothing to empty: no Empty button.
    expect(within(dialog).queryByRole('button', { name: 'Empty Recently deleted' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Beta' }));
    expect(remove).toHaveBeenCalledWith('b');
    // Nothing is saved by it: the person presses Save as a project again.
    expect(useProjectStore.getState().keptEdits?.saving).toBe(false);
  });

  it('also offers to empty Recently deleted, after a confirm, when it has items', async () => {
    keptWith(STORAGE, 'storage', { trash: [{ ...summary('old', 'Old one'), deletedAt: '2026-10-01T00:00:00Z', purgeAt: '2026-10-31T00:00:00Z' }] });
    render(<KeptEditsNotice />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose a project to delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose a project to delete' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Empty Recently deleted' }));
    expect(emptyTrash).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Delete this project for good\?/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete forever' }));
    expect(emptyTrash).toHaveBeenCalledTimes(1);
  });

  it('Escape closes it and focus goes back to the button', async () => {
    keptWith(AT_LIMIT, 'projects');
    render(<KeptEditsNotice />);
    const button = screen.getByRole('button', { name: 'Choose a project to delete' });
    button.focus();
    fireEvent.click(button);
    await screen.findByRole('dialog', { name: 'Choose a project to delete' });
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(button);
  });
});
