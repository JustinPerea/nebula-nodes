import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Moodboard } from '../../types';

const api = vi.hoisted(() => ({
  analyzeMoodboard: vi.fn(),
  createMoodboard: vi.fn(),
  fetchMoodboard: vi.fn(),
  fetchMoodboards: vi.fn(),
  keepMoodboardBriefOverride: vi.fn(),
  lookupStoredAsset: vi.fn(),
  updateMoodboard: vi.fn(),
}));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/backend', () => ({ apiFetch: vi.fn(), backendAssetUrlSync: (url: string) => url }));
vi.mock('../../lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));
vi.mock('../WorkspaceHeader', () => ({
  WorkspaceHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../asset-trash/AssetTrash', () => ({ RecentlyDeletedAssets: () => null, UndoDeleteToast: () => null }));
vi.mock('../../hooks/useAssetDelete', () => ({
  useAssetDelete: () => ({ lastDeleted: null, busy: false, error: null, refreshKey: 0, remove: vi.fn(),
    undo: vi.fn(), dismiss: vi.fn(), refresh: vi.fn() }),
}));

import { MoodboardStudioView } from './MoodboardStudioView';
import { emptyRailMessage } from '../../lib/assetHome';
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { assetStudioDraftKey, useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { NEW_MOODBOARD_SENTINEL } from '../../lib/studioSentinels';

const analysis = { version: 2, sourceHash: 'h1', summary: 'Warm.', palette: ['#e8593c'], accents: [] };

function board(overrides: Partial<Moodboard> = {}): Moodboard {
  return {
    id: 'g1', name: 'Global board', version: 1, notes: '', mode: 'look', strength: 0.7,
    images: [{ id: 'i1', url: '/api/outputs/a.png', weight: 1, notes: '', privateNote: '', excluded: false }],
    analysis, direction: '', avoid: [], pinnedColors: { include: [], exclude: [] }, briefOverride: null,
    thumbnail: '/api/outputs/a.png', projectId: undefined, createdAt: '', updatedAt: '',
    ...overrides,
  } as unknown as Moodboard;
}

const boards: Record<string, Moodboard> = {};

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  for (const key of Object.keys(boards)) delete boards[key];
  boards.g1 = board();
  boards.p1 = board({ id: 'p1b', name: 'Project board', projectId: 'p1' });
  boards.p1b = boards.p1;
  api.fetchMoodboard.mockImplementation(async (id: string) => boards[id] ?? null);
  api.fetchMoodboards.mockImplementation(async (scope: string, projectId?: string) => Object.values(boards)
    .filter((item, index, all) => all.indexOf(item) === index)
    .filter((item) => (scope === 'project' ? item.projectId === projectId : !item.projectId)));
  api.createMoodboard.mockImplementation(async (body: Partial<Moodboard>) => ({ ...board(), ...body, id: 'made1' }));
  api.updateMoodboard.mockImplementation(async (id: string, body: Partial<Moodboard>) => ({ ...boards[id], ...body }));
  api.lookupStoredAsset.mockResolvedValue({ status: 'missing' });
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  setOpenProject(['p1', 'Project'], [['pA', 'Shoot A']]);
});

async function openStudio(id: string, scope: 'global' | 'project', name: string) {
  act(() => { useUIStore.getState().enterMoodboardEditor(id, scope); });
  const view = render(<MoodboardStudioView />);
  await screen.findByDisplayValue(name);
  return view;
}

const tab = (name: 'Project' | 'Global') => screen.getByRole('tab', { name });

describe('Moodboard Studio rail', () => {
  it('opens on Global for a Global board, even when it was opened with a project hint and its draft is kept', async () => {
    (await openStudio('g1', 'global', 'Global board')).unmount();
    // The same board again, opened from somewhere that guessed "project":
    // the draft is kept, so the Studio loads it without fetching.
    await openStudio('g1', 'project', 'Global board');
    await waitFor(() => expect(useUIStore.getState().moodboardEditorScope).toBe('global'));
    await waitFor(() => expect(tab('Global').getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByRole('button', { name: /Global board/ })).toBeTruthy();
    expect(screen.queryByText('No Moodboards yet.')).toBeNull();
  });

  it('opens on Project for a project board opened from a node (which guesses Global), every time', async () => {
    (await openStudio('p1b', 'global', 'Project board')).unmount();
    await openStudio('p1b', 'global', 'Project board');
    await waitFor(() => expect(tab('Project').getAttribute('aria-selected')).toBe('true'));
  });

  it('says where the open board is when the other scope is empty', async () => {
    delete boards.p1;
    delete boards.p1b;
    await openStudio('g1', 'global', 'Global board');
    fireEvent.click(tab('Project'));
    expect(await screen.findByText('No project moodboards. This board is Global.')).toBeTruthy();
    expect(emptyRailMessage('moodboard', 'global', { scope: 'project', here: true }))
      .toBe('No global moodboards. This board is in this project.');
    expect(emptyRailMessage('moodboard', 'project', null)).toBe('No project moodboards yet.');
    expect(emptyRailMessage('moodboard', 'project', null, false)).toBe('Open a project to see its moodboards.');
  });
});

describe('Moodboard Studio private note', () => {
  it('saves the private note and keeps the analysis; a steering change clears it', async () => {
    await openStudio('g1', 'global', 'Global board');
    const privateNote = screen.getByRole('textbox', { name: 'Private note' });
    expect(screen.getByText('Only for you. Not sent anywhere.')).toBeTruthy();
    fireEvent.change(privateNote, { target: { value: 'PAINTERLY (liked)' } });

    await waitFor(() => expect(api.updateMoodboard).toHaveBeenCalled(), { timeout: 3000 });
    const [, body] = api.updateMoodboard.mock.calls.at(-1)!;
    expect(body.images[0].privateNote).toBe('PAINTERLY (liked)');
    expect(body.analysis).toEqual(analysis);
    expect(screen.getByText('Warm.')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Image note' }), { target: { value: 'the orange' } });
    await waitFor(() => expect(api.updateMoodboard.mock.calls.at(-1)![1].images[0].notes).toBe('the orange'),
      { timeout: 3000 });
    expect(api.updateMoodboard.mock.calls.at(-1)![1].analysis).toBeNull();
  });
});

describe('Moodboard Studio and the open canvas project', () => {
  it("opens another project's board (a pasted node, a link) and says where it lives; saving keeps it there", async () => {
    boards.pa1 = board({ id: 'pa1', name: 'Shoot A board', projectId: 'pA' });
    await openStudio('pa1', 'global', 'Shoot A board');

    await waitFor(() => expect(tab('Project').getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByText('This board is in Shoot A.')).toBeTruthy();
    // Its own project's list isn't this one: no "lost board" reading.
    expect(api.fetchMoodboards).toHaveBeenCalledWith('project', 'p1');

    fireEvent.change(screen.getByDisplayValue('Shoot A board'), { target: { value: 'Shoot A board, edited' } });
    await waitFor(() => expect(api.updateMoodboard).toHaveBeenCalled(), { timeout: 3000 });
    const [id, body] = api.updateMoodboard.mock.calls.at(-1)!;
    expect(id).toBe('pa1');
    expect(body.projectId).toBe('pA');
    expect(api.createMoodboard).not.toHaveBeenCalled();
  });

  it('says "another project" when that project is not known here', async () => {
    boards.px = board({ id: 'px', name: 'Far board', projectId: 'pX' });
    await openStudio('px', 'project', 'Far board');
    expect(await screen.findByText('This board is in another project.')).toBeTruthy();
  });

  it('with no project open, the Project tab says to open one and New is off', async () => {
    setOpenProject(null);
    await openStudio('g1', 'global', 'Global board');
    fireEvent.click(tab('Project'));
    expect(await screen.findByText('Open a project to see its moodboards.')).toBeTruthy();
    expect((screen.getByRole('button', { name: '+ New Moodboard' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.fetchMoodboards).not.toHaveBeenCalledWith('project', expect.anything());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a new project draft is filed under the project it was started in, never the one opened after', async () => {
    act(() => { useUIStore.getState().enterMoodboardEditor(NEW_MOODBOARD_SENTINEL, 'project'); });
    render(<MoodboardStudioView />);
    await screen.findByDisplayValue('Untitled Moodboard');
    const p1Key = assetStudioDraftKey('moodboard', 'project', NEW_MOODBOARD_SENTINEL, 'p1');
    // Name it and add an image, then an agent opens another project before the autosave.
    act(() => {
      useAssetStudioDraftStore.getState().edit(p1Key, (draft) => ({ ...(draft as object), name: 'For p1',
        images: [{ id: 'i9', url: '/api/outputs/z.png', weight: 1, notes: '', privateNote: '', excluded: false }] }));
    });
    act(() => { setOpenProject(['p2', 'Second'], [['p1', 'Project']]); });

    // The Studio shows p2's own new draft; p1's is kept, not saved into p2.
    await screen.findByDisplayValue('Untitled Moodboard');
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(api.createMoodboard).not.toHaveBeenCalled();
    await waitFor(() => expect(api.fetchMoodboards).toHaveBeenCalledWith('project', 'p2'));

    // Back in p1, it saves there.
    act(() => { setOpenProject(['p1', 'Project'], [['p2', 'Second']]); });
    expect(await screen.findByDisplayValue('For p1')).toBeTruthy();
    await waitFor(() => expect(api.createMoodboard).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.createMoodboard.mock.calls.every(([body]) => body.projectId === 'p1')).toBe(true);
  });
});
