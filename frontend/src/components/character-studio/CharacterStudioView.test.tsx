import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Character } from '../../types';

const api = vi.hoisted(() => ({
  createCharacter: vi.fn(),
  fetchCharacter: vi.fn(),
  fetchCharacters: vi.fn(),
  lookupStoredAsset: vi.fn(),
  moveStoredAsset: vi.fn(),
  updateCharacter: vi.fn(),
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

import { CharacterStudioView } from './CharacterStudioView';
import { useUIStore } from '../../store/uiStore';
import { assetStudioDraftKey, useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { setOpenProject } from '../../test/projectState';

function character(overrides: Partial<Character> = {}): Character {
  return {
    id: 'c1', name: 'Nari', version: 1, subjectType: 'human', referenceViews: ['/a.png', '/b.png', '/c.png'],
    frozenTraitString: 'silver hair', seed: 1, consistencyStrength: 0.8, thumbnail: '/a.png',
    projectId: undefined, createdAt: '', updatedAt: '', ...overrides,
  } as Character;
}

const characters: Record<string, Character> = {};

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  for (const key of Object.keys(characters)) delete characters[key];
  characters.c1 = character();
  characters.cp = character({ id: 'cp', name: 'Project hero', projectId: 'p1' });
  characters.ca = character({ id: 'ca', name: 'Shoot A hero', projectId: 'pA' });
  api.fetchCharacter.mockImplementation(async (id: string) => characters[id] ?? null);
  api.fetchCharacters.mockImplementation(async (scope: string, projectId?: string) => Object.values(characters)
    .filter((item) => (scope === 'project' ? item.projectId === projectId : !item.projectId)));
  api.updateCharacter.mockImplementation(async (id: string, body: Partial<Character>) => ({ ...characters[id], ...body }));
  api.lookupStoredAsset.mockResolvedValue({ status: 'missing' });
  api.moveStoredAsset.mockImplementation(async (_kind: string, id: string, to: string | null) => {
    const from = characters[id].projectId ?? null;
    characters[id] = { ...characters[id], projectId: to ?? undefined };
    return { status: 'moved', from, to, fromName: from ?? 'Global', toName: to ?? 'Global', detail: '', asset: characters[id] };
  });
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  setOpenProject(['p1', 'Project'], [['pA', 'Shoot A']]);
});

async function openStudio(id: string, scope: 'global' | 'project', name: string) {
  act(() => { useUIStore.getState().enterCharacterEditor(id, scope); });
  const view = render(<CharacterStudioView />);
  await screen.findByDisplayValue(name);
  return view;
}

const tab = (name: 'Project' | 'Global') => screen.getByRole('tab', { name });

describe('Character Studio rail', () => {
  it("opens on Project for a project Character opened with a Global hint, also when its draft is kept (no fetch)", async () => {
    (await openStudio('cp', 'global', 'Project hero')).unmount();
    // The same Character again from a node's Open button (which guesses Global):
    // the draft is kept, so it loads without fetching.
    act(() => { useUIStore.setState({ characterEditorScope: 'global' }); });
    await openStudio('cp', 'global', 'Project hero');
    await waitFor(() => expect(tab('Project').getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByRole('button', { name: /Project hero/ })).toBeTruthy();
  });

  it("says another project's Character lives there, and saving edits keeps it there", async () => {
    await openStudio('ca', 'global', 'Shoot A hero');
    await waitFor(() => expect(tab('Project').getAttribute('aria-selected')).toBe('true'));
    expect(await screen.findByText('This Character is in Shoot A.')).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue('Shoot A hero'), { target: { value: 'Shoot A hero 2' } });
    await waitFor(() => expect(api.updateCharacter).toHaveBeenCalled(), { timeout: 3000 });
    const [id, body] = api.updateCharacter.mock.calls.at(-1)!;
    expect(id).toBe('ca');
    expect(body.projectId).toBe('pA');
    expect(api.createCharacter).not.toHaveBeenCalled();
  });

  it('a Global Character with an empty Project tab says it is Global', async () => {
    delete characters.cp;
    await openStudio('c1', 'global', 'Nari');
    fireEvent.click(tab('Project'));
    expect(await screen.findByText('No project Characters. This Character is Global.')).toBeTruthy();
  });

  it('with no project open, the Project tab says to open one and New is off', async () => {
    setOpenProject(null);
    await openStudio('c1', 'global', 'Nari');
    fireEvent.click(tab('Project'));
    expect(await screen.findByText('Open a project to see its Characters.')).toBeTruthy();
    expect((screen.getByRole('button', { name: '+ New Character' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.fetchCharacters).not.toHaveBeenCalledWith('project', expect.anything());
  });

  it('switching projects lists the new project in the Project tab', async () => {
    await openStudio('cp', 'project', 'Project hero');
    await waitFor(() => expect(api.fetchCharacters).toHaveBeenCalledWith('project', 'p1'));
    act(() => { setOpenProject(['pA', 'Shoot A'], [['p1', 'Project']]); });
    await waitFor(() => expect(api.fetchCharacters).toHaveBeenCalledWith('project', 'pA'));
    expect(await screen.findByRole('button', { name: /Shoot A hero/ })).toBeTruthy();
    // The open Character is now the other project's, and the rail says so.
    expect(await screen.findByText('This Character is in Project.')).toBeTruthy();
  });
});

describe('Character Studio Move', () => {
  const items = () => screen.queryAllByRole('menuitem').map((item) => item.querySelector('.asset-move__label')?.textContent);

  it('offers the choices for where the Character lives', async () => {
    let view = await openStudio('c1', 'global', 'Nari');
    fireEvent.click(screen.getByRole('button', { name: /^Move/ }));
    expect(items()).toEqual(['Move to Project']);
    view.unmount();
    view = await openStudio('cp', 'project', 'Project hero');
    fireEvent.click(screen.getByRole('button', { name: /^Move/ }));
    expect(items()).toEqual(['Move to Global']);
    view.unmount();
    await openStudio('ca', 'project', 'Shoot A hero');
    fireEvent.click(screen.getByRole('button', { name: /^Move/ }));
    expect(items()).toEqual(['Move to Global', 'Move to Project']);
  });

  it('moves a Global Character into the open project: the rail switches and the draft key moves', async () => {
    await openStudio('c1', 'global', 'Nari');
    fireEvent.click(screen.getByRole('button', { name: /^Move/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Project' }));
    await waitFor(() => expect(api.moveStoredAsset).toHaveBeenCalledWith('character', 'c1', 'p1'));
    await waitFor(() => expect(tab('Project').getAttribute('aria-selected')).toBe('true'));
    expect(useUIStore.getState().characterEditorScope).toBe('project');
    const entry = useAssetStudioDraftStore.getState().entries[assetStudioDraftKey('character', 'project', 'c1', 'p1')];
    expect((entry?.draft as { projectId?: string }).projectId).toBe('p1');
    expect(screen.getByDisplayValue('Nari')).toBeTruthy();
  });

  it('saves unsaved edits before it moves, and keeps them', async () => {
    await openStudio('c1', 'global', 'Nari');
    fireEvent.change(screen.getByDisplayValue('Nari'), { target: { value: 'Nari 2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Move/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Project' }));
    await waitFor(() => expect(api.moveStoredAsset).toHaveBeenCalled());
    expect(api.updateCharacter.mock.calls[0][1]).toMatchObject({ name: 'Nari 2' });
    expect(api.updateCharacter.mock.invocationCallOrder[0]).toBeLessThan(api.moveStoredAsset.mock.invocationCallOrder[0]);
    await waitFor(() => expect(tab('Project').getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByDisplayValue('Nari 2')).toBeTruthy();
  });

  it('with no project open, Move to a project is off', async () => {
    setOpenProject(null);
    await openStudio('c1', 'global', 'Nari');
    fireEvent.click(screen.getByRole('button', { name: /^Move/ }));
    const [only] = screen.getAllByRole('menuitem');
    expect(only.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(only);
    expect(api.moveStoredAsset).not.toHaveBeenCalled();
  });
});
