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
vi.mock('../../lib/currentProject', () => ({ getCurrentProject: () => Promise.resolve({ id: 'p1', name: 'Project' }) }));
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
import { emptyRailMessage } from './railEmpty';
import { useUIStore } from '../../store/uiStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';

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
  api.fetchMoodboards.mockImplementation(async (scope: string) => Object.values(boards)
    .filter((item, index, all) => all.indexOf(item) === index)
    .filter((item) => (scope === 'project' ? Boolean(item.projectId) : !item.projectId)));
  api.updateMoodboard.mockImplementation(async (id: string, body: Partial<Moodboard>) => ({ ...boards[id], ...body }));
  api.lookupStoredAsset.mockResolvedValue({ status: 'missing' });
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {}, projectId: null });
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
    expect(emptyRailMessage('global', 'project')).toBe('No global moodboards. This board is in this project.');
    expect(emptyRailMessage('project', null)).toBe('No project moodboards yet.');
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
