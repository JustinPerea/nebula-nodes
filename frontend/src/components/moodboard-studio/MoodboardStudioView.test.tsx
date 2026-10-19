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
  moveStoredAsset: vi.fn(),
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

/** What the backend's move answers, after moving the stored board. */
function movedTo(id: string, to: string | null) {
  const from = boards[id].projectId ?? null;
  const moved = { ...boards[id], projectId: to ?? undefined } as Moodboard;
  for (const key of Object.keys(boards)) if (boards[key].id === id) boards[key] = moved;
  return { status: 'moved', from, to, fromName: from ?? 'Global', toName: to ?? 'Global', detail: '', asset: moved };
}

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
  api.moveStoredAsset.mockImplementation(async (_kind: string, id: string, to: string | null) => movedTo(id, to));
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

const menuItems = () => screen.queryAllByRole('menuitem').map((item) => [item.textContent, item.getAttribute('aria-disabled') === 'true']);
const openMove = () => fireEvent.click(screen.getByRole('button', { name: /^Move/ }));

describe('Moodboard Studio Move', () => {
  it('offers Move to <open project> for a Global board, and Move to Global for one in this project', async () => {
    const view = await openStudio('g1', 'global', 'Global board');
    openMove();
    expect(menuItems()).toEqual([['Move to Project', false]]);
    view.unmount();

    await openStudio('p1b', 'project', 'Project board');
    openMove();
    expect(menuItems()).toEqual([['Move to Global', false]]);
  });

  it("offers both for another project's board; with no project open, Move to a project is off", async () => {
    boards.pa1 = board({ id: 'pa1', name: 'Shoot A board', projectId: 'pA' });
    const view = await openStudio('pa1', 'project', 'Shoot A board');
    openMove();
    expect(menuItems()).toEqual([['Move to Global', false], ['Move to Project', false]]);
    view.unmount();

    // (A project board doesn't open with no project open, so only a Global one can be here.)
    setOpenProject(null);
    await openStudio('g1', 'global', 'Global board');
    openMove();
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.querySelector('.asset-move__label')?.textContent)).toEqual(['Move to a project']);
    expect(items[0].getAttribute('aria-disabled')).toBe('true');
    expect(items[0].textContent).toContain('No project is open');
    fireEvent.click(items[0]);
    expect(api.moveStoredAsset).not.toHaveBeenCalled();
  });

  it('moves a Global board into the open project: the rail follows, the draft key moves, saves keep the new home', async () => {
    await openStudio('g1', 'global', 'Global board');
    expect(tab('Global').getAttribute('aria-selected')).toBe('true');
    openMove();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Project' }));

    await waitFor(() => expect(api.moveStoredAsset).toHaveBeenCalledWith('moodboard', 'g1', 'p1'));
    await waitFor(() => expect(useUIStore.getState().moodboardEditorScope).toBe('project'));
    await waitFor(() => expect(tab('Project').getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByRole('button', { name: /Global board/ })).toBeTruthy();
    const drafts = useAssetStudioDraftStore.getState();
    const moved = drafts.entries[assetStudioDraftKey('moodboard', 'project', 'g1', 'p1')];
    expect((moved?.draft as { projectId?: string }).projectId).toBe('p1');
    expect(drafts.entries[assetStudioDraftKey('moodboard', 'global', 'g1')]).toBeUndefined();

    fireEvent.change(screen.getByDisplayValue('Global board'), { target: { value: 'House style' } });
    await waitFor(() => expect(api.updateMoodboard).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.updateMoodboard.mock.calls.at(-1)![1]).toMatchObject({ name: 'House style', projectId: 'p1' });
  });

  it("moves another project's board to Global: the notice goes and the Global tab shows it", async () => {
    boards.pa1 = board({ id: 'pa1', name: 'Shoot A board', projectId: 'pA' });
    await openStudio('pa1', 'project', 'Shoot A board');
    expect(await screen.findByText('This board is in Shoot A.')).toBeTruthy();
    openMove();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Global' }));

    await waitFor(() => expect(tab('Global').getAttribute('aria-selected')).toBe('true'));
    expect(screen.queryByText('This board is in Shoot A.')).toBeNull();
    expect(useUIStore.getState().moodboardEditorScope).toBe('global');
    expect(api.moveStoredAsset).toHaveBeenCalledWith('moodboard', 'pa1', null);
  });

  it('moving it into the open project from another keeps the scope and key, and drops the notice', async () => {
    boards.pa1 = board({ id: 'pa1', name: 'Shoot A board', projectId: 'pA' });
    await openStudio('pa1', 'project', 'Shoot A board');
    expect(await screen.findByText('This board is in Shoot A.')).toBeTruthy();
    openMove();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Project' }));
    await waitFor(() => expect(screen.queryByText('This board is in Shoot A.')).toBeNull());
    const entry = useAssetStudioDraftStore.getState().entries[assetStudioDraftKey('moodboard', 'project', 'pa1', 'p1')];
    expect((entry?.draft as { projectId?: string }).projectId).toBe('p1');
  });

  it('saves unsaved edits first, then moves; edits typed during the move are kept and saved to the new home', async () => {
    await openStudio('g1', 'global', 'Global board');
    let finish: (() => void) | null = null;
    api.moveStoredAsset.mockImplementation((_kind: string, id: string, to: string | null) =>
      new Promise((resolve) => { finish = () => resolve(movedTo(id, to)); }));
    fireEvent.change(screen.getByDisplayValue('Global board'), { target: { value: 'Edited before' } });
    openMove();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Project' }));

    await waitFor(() => expect(api.moveStoredAsset).toHaveBeenCalled());
    // The save went first, with the board still Global.
    expect(api.updateMoodboard).toHaveBeenCalledTimes(1);
    expect(api.updateMoodboard.mock.calls[0][1]).toMatchObject({ name: 'Edited before' });
    expect(api.updateMoodboard.mock.calls[0][1].projectId).toBeUndefined();
    expect(api.updateMoodboard.mock.invocationCallOrder[0]).toBeLessThan(api.moveStoredAsset.mock.invocationCallOrder[0]);

    fireEvent.change(screen.getByDisplayValue('Edited before'), { target: { value: 'Typed while moving' } });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(api.updateMoodboard).toHaveBeenCalledTimes(1); // no save with the old home mid-move
    await act(async () => { finish!(); });

    expect(await screen.findByDisplayValue('Typed while moving')).toBeTruthy();
    await waitFor(() => expect(api.updateMoodboard).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(api.updateMoodboard.mock.calls[1][1]).toMatchObject({ name: 'Typed while moving', projectId: 'p1' });
  });

  it('the move broadcast landing before its answer (re-homing the draft) leaves no save stuck', async () => {
    await openStudio('g1', 'global', 'Global board');
    api.moveStoredAsset.mockImplementation(async (_kind: string, id: string, to: string | null) => {
      useAssetStudioDraftStore.getState().rehome('moodboard', id, to); // storedAssetChanged arrives first
      return movedTo(id, to);
    });
    openMove();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Project' }));
    await waitFor(() => expect(tab('Project').getAttribute('aria-selected')).toBe('true'));
    const entry = useAssetStudioDraftStore.getState().entries[assetStudioDraftKey('moodboard', 'project', 'g1', 'p1')];
    expect(entry?.pendingSaveId).toBeNull();
    expect(entry?.saveState).toBe('saved');
    fireEvent.change(screen.getByDisplayValue('Global board'), { target: { value: 'After the race' } });
    await waitFor(() => expect(api.updateMoodboard).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.updateMoodboard.mock.calls.at(-1)![1]).toMatchObject({ name: 'After the race', projectId: 'p1' });
  });

  it("doesn't move when saving the edits fails, and a refused move keeps the draft", async () => {
    await openStudio('g1', 'global', 'Global board');
    api.updateMoodboard.mockRejectedValueOnce(new Error('Save failed: disk full'));
    fireEvent.change(screen.getByDisplayValue('Global board'), { target: { value: 'Unsaved' } });
    openMove();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Project' }));
    expect(await screen.findByText('Save failed: disk full')).toBeTruthy();
    expect(api.moveStoredAsset).not.toHaveBeenCalled();

    api.moveStoredAsset.mockRejectedValueOnce(new Error('Move failed: No project has the id'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.updateMoodboard).toHaveBeenCalledTimes(2));
    openMove();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Project' }));
    expect(await screen.findByText('Move failed: No project has the id')).toBeTruthy();
    expect(screen.getByDisplayValue('Unsaved')).toBeTruthy();
    expect(useUIStore.getState().moodboardEditorScope).toBe('global');
    const entry = useAssetStudioDraftStore.getState().entries[assetStudioDraftKey('moodboard', 'global', 'g1')];
    expect(entry?.pendingSaveId).toBeNull();
    expect(entry?.saveState).toBe('saved');
  });
});

// -- gap 18: the brief's left-out list, the clash setting and the notes switch ----

const leftOutBrief = {
  styleBrief: 'Use the Nebula moodboard.', generatedStyleBrief: 'Use the Nebula moodboard.', negativePrompt: 'blurry',
  avoid: ['red flowers'], avoidPrompt: '', direction: '', pinnedColors: { include: [], exclude: [] },
  palette: [], accents: [], override: { active: false, stale: false }, needsAnalysis: false,
  clashMode: 'leave-out', notesSent: false, kept: [], mayClash: [], pinnedClashes: [], paletteClashes: [],
  leftOut: [{ hex: '#e8593c', role: 'palette', level: 'conflict', why: 'check', reason: 'Avoid: red flowers',
    reasons: ['Avoid: red flowers'], foundBy: ['words'] }],
};

describe('Moodboard Studio: what generators get', () => {
  it('lists what the brief left out and saves Keep anyway, keeping the analysis', async () => {
    boards.g1 = board({ brief: leftOutBrief } as Partial<Moodboard>);
    await openStudio('g1', 'global', 'Global board');
    expect((await screen.findByRole('list', { name: 'Left out of the brief' })).textContent)
      .toContain('Avoid: red flowers');
    fireEvent.click(screen.getByRole('button', { name: 'Keep #e8593c anyway' }));
    await waitFor(() => expect(api.updateMoodboard).toHaveBeenCalled(), { timeout: 3000 });
    const [, body] = api.updateMoodboard.mock.calls.at(-1)!;
    expect(body.colorChoices).toEqual({ keep: ['#e8593c'], leaveOut: [] });
    expect(body.analysis).toEqual(analysis);
  });

  it('has a notes switch, off, that says who the notes are for', async () => {
    await openStudio('g1', 'global', 'Global board');
    const toggle = screen.getByRole('switch', { name: 'Send these notes to generators' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Off: notes are for you, your team and agents.')).toBeTruthy();
    expect(screen.getByPlaceholderText('Anything about the board, in your words.')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.updateMoodboard.mock.calls.at(-1)?.[1].sendNotes).toBe(true), { timeout: 3000 });
    // Sending notes or not doesn't change what the analysis read.
    expect(api.updateMoodboard.mock.calls.at(-1)![1].analysis).toEqual(analysis);
  });

  it('saves the clash setting from Advanced', async () => {
    await openStudio('g1', 'global', 'Global board');
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(screen.getByLabelText(/Flag clashes, leave nothing out/));
    await waitFor(() => expect(api.updateMoodboard.mock.calls.at(-1)?.[1].clashMode).toBe('flag'), { timeout: 3000 });
  });
});

describe('Moodboard Studio: choices the person saves', () => {
  it('a new board starts with its notes held back from generators', async () => {
    act(() => { useUIStore.getState().enterMoodboardEditor(NEW_MOODBOARD_SENTINEL, 'global'); });
    render(<MoodboardStudioView />);
    await screen.findByDisplayValue('Untitled Moodboard');
    expect(screen.getByRole('switch', { name: 'Send these notes to generators' }).getAttribute('aria-checked'))
      .toBe('false');
    const key = assetStudioDraftKey('moodboard', 'global', NEW_MOODBOARD_SENTINEL, 'p1');
    act(() => {
      useAssetStudioDraftStore.getState().edit(key, (draft) => ({ ...(draft as object), name: 'Fresh',
        images: [{ id: 'i9', url: '/api/outputs/z.png', weight: 1, notes: '', privateNote: '', excluded: false }] }));
    });
    await waitFor(() => expect(api.createMoodboard).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.createMoodboard.mock.calls[0][0].sendNotes).toBe(false);
  });

  it('Undo on a kept color saves it without that choice', async () => {
    boards.g1 = board({
      colorChoices: { keep: ['#e8593c'], leaveOut: [] },
      brief: { ...leftOutBrief, leftOut: [], kept: [{ ...leftOutBrief.leftOut[0], why: 'choice' }] },
    } as Partial<Moodboard>);
    await openStudio('g1', 'global', 'Global board');
    fireEvent.click(await screen.findByRole('button', { name: 'Undo keeping #e8593c' }));
    await waitFor(() => expect(api.updateMoodboard).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.updateMoodboard.mock.calls.at(-1)![1].colorChoices).toEqual({ keep: [], leaveOut: [] });
  });

  it('pinning a kept color to keep out drops it from Keep anyway, so the save is accepted', async () => {
    boards.g1 = board({ colorChoices: { keep: ['#e8593c'], leaveOut: [] } } as Partial<Moodboard>);
    await openStudio('g1', 'global', 'Global board');
    const input = screen.getByLabelText('Colors to keep out: hex');
    fireEvent.change(input, { target: { value: '#e8593c' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.updateMoodboard).toHaveBeenCalled(), { timeout: 3000 });
    const [, body] = api.updateMoodboard.mock.calls.at(-1)!;
    expect(body.pinnedColors.exclude).toEqual(['#e8593c']);
    expect(body.colorChoices.keep).toEqual([]);
  });
});
