import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Character } from '../../types';

// The open Character Studio and outside writers on one Character (an agent,
// another tab): the Studio follows their edits live, sends only the fields
// the person changed with the version it read, never overwrites the person's
// unsaved edits, and says so when both changed the same field.

const api = vi.hoisted(() => ({
  createCharacter: vi.fn(),
  fetchCharacter: vi.fn(),
  fetchCharacters: vi.fn(),
  lookupStoredAsset: vi.fn(),
  moveStoredAsset: vi.fn(),
  updateCharacter: vi.fn(),
}));
const socket = vi.hoisted(() => ({ handlers: new Set<(event: unknown) => void>() }));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/backend', () => ({ apiFetch: vi.fn(), backendAssetUrlSync: (url: string) => url }));
vi.mock('../../lib/wsClient', () => ({
  wsClient: {
    subscribe: (handler: (event: unknown) => void) => { socket.handlers.add(handler); return () => socket.handlers.delete(handler); },
    connect: () => {},
    send: () => {},
  },
}));
vi.mock('../WorkspaceHeader', () => ({
  WorkspaceHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));
vi.mock('../asset-trash/AssetTrash', () => ({ RecentlyDeletedAssets: () => null, UndoDeleteToast: () => null }));
vi.mock('../../hooks/useAssetDelete', () => ({
  useAssetDelete: () => ({ lastDeleted: null, busy: false, error: null, refreshKey: 0, remove: vi.fn(),
    undo: vi.fn(), dismiss: vi.fn(), refresh: vi.fn() }),
}));

import { CharacterStudioView } from './CharacterStudioView';
import { CharacterVersionConflict } from '../../lib/characterEdits';
import { TAB_ID } from '../../lib/tabId';
import { setOpenProject } from '../../test/projectState';
import { useUIStore } from '../../store/uiStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';

/** The backend, as far as these tests need it: one Character, its version,
 *  and PUT merging what it is sent, refusing a stale baseVersion with the
 *  Character as it is now. */
const server: { character: Character; puts: Record<string, unknown>[] } = {
  character: null as unknown as Character, puts: [],
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function outsideWrite(patch: Partial<Character>, { announce = true, actor = { kind: 'agent', name: 'Claude' } as
  { kind: string; name?: string }, tab }: { announce?: boolean; actor?: { kind: string; name?: string }; tab?: string } = {}) {
  server.character = { ...server.character, ...patch, version: server.character.version + 1 };
  if (!announce) return;
  act(() => {
    for (const handler of socket.handlers) {
      handler({ type: 'storedAssetChanged', kind: 'character', id: server.character.id, deleted: false,
        version: server.character.version, edit: { actor, ...(tab ? { tab } : {}) } });
    }
  });
}

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  socket.handlers.clear();
  server.character = {
    id: 'c1', name: 'Nari', version: 1, subjectType: 'human', referenceViews: ['/a.png', '/b.png', '/c.png'],
    frozenTraitString: 'silver hair', seed: 1, consistencyStrength: 0.8, thumbnail: '/a.png',
    projectId: undefined, createdAt: '', updatedAt: '',
  } as unknown as Character;
  server.puts = [];
  api.fetchCharacter.mockImplementation(async (id: string) => (id === server.character.id ? clone(server.character) : null));
  api.fetchCharacters.mockImplementation(async (scope: string) => (scope === 'global' ? [clone(server.character)] : []));
  api.lookupStoredAsset.mockResolvedValue({ status: 'missing' });
  api.updateCharacter.mockImplementation(async (_id: string, body: Record<string, unknown>) => {
    server.puts.push(body);
    if (typeof body.baseVersion === 'number' && body.baseVersion !== server.character.version) {
      throw new CharacterVersionConflict(clone(server.character));
    }
    const fields = { ...body };
    delete fields.baseVersion;
    delete fields.projectId;
    server.character = { ...server.character, ...fields, version: server.character.version + 1 } as Character;
    return clone(server.character);
  });
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  setOpenProject(['p1', 'Project']);
});

async function openStudio() {
  act(() => { useUIStore.getState().enterCharacterEditor('c1', 'global'); });
  const view = render(<CharacterStudioView />);
  await screen.findByDisplayValue('Nari');
  return view;
}

const traits = () => screen.getByLabelText(/^Frozen trait string/) as HTMLTextAreaElement;
const name = () => screen.getByLabelText('Name') as HTMLInputElement;

describe('Character Studio follows outside edits', () => {
  it("an agent's edit shows while the Studio is open, without a reload", async () => {
    await openStudio();
    outsideWrite({ frozenTraitString: 'silver hair, scar over the left eye' });
    await waitFor(() => expect(traits().value).toBe('silver hair, scar over the left eye'));
    // Nothing of the person's to save, so nothing is sent back.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(api.updateCharacter).not.toHaveBeenCalled();
  });

  it("the person's unsaved edit survives an agent's edit of another field, and both are saved", async () => {
    await openStudio();
    fireEvent.change(name(), { target: { value: 'Nari Vale' } });
    outsideWrite({ frozenTraitString: 'freckles' });
    await waitFor(() => expect(traits().value).toBe('freckles'));
    expect(name().value).toBe('Nari Vale');

    await waitFor(() => expect(api.updateCharacter).toHaveBeenCalled(), { timeout: 3000 });
    const [, body] = api.updateCharacter.mock.calls.at(-1)!;
    // Only what the person changed, with the version it read.
    expect(body).toEqual({ name: 'Nari Vale', baseVersion: 2 });
    expect(server.character).toMatchObject({ name: 'Nari Vale', frozenTraitString: 'freckles', version: 3 });
  });

  it('a save that lost the race to an outside edit reads it, keeps both and sends again', async () => {
    await openStudio();
    outsideWrite({ seed: 42 }, { announce: false });
    fireEvent.change(name(), { target: { value: 'Nari 2' } });
    await waitFor(() => expect(server.puts).toHaveLength(2), { timeout: 3000 });
    expect(server.puts[0]).toEqual({ name: 'Nari 2', baseVersion: 1 });
    expect(server.puts[1]).toEqual({ name: 'Nari 2', baseVersion: 2 });
    expect(server.character).toMatchObject({ name: 'Nari 2', seed: 42, version: 3 });
    await waitFor(() => expect((screen.getByLabelText('Seed') as HTMLInputElement).value).toBe('42'));
    expect(screen.queryByRole('status', { name: /changed/ })).toBeNull();
  });

  it('when both changed the same field: theirs is not lost, a note says who, and Use theirs puts it back', async () => {
    await openStudio();
    fireEvent.change(traits(), { target: { value: 'silver hair, my words' } });
    outsideWrite({ frozenTraitString: 'silver hair, agent words' });
    const note = await screen.findByRole('status', { name: /Claude also changed the frozen trait string/ });
    expect(note.textContent).toContain('Yours is kept');
    expect(traits().value).toBe('silver hair, my words');

    await waitFor(() => expect(server.character.frozenTraitString).toBe('silver hair, my words'), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Use theirs' }));
    expect(traits().value).toBe('silver hair, agent words');
    expect(screen.queryByRole('status', { name: /also changed/ })).toBeNull();
    await waitFor(() => expect(server.character.frozenTraitString).toBe('silver hair, agent words'), { timeout: 3000 });
  });

  it('Use theirs clicked while the save of the person\'s value is out still puts theirs back', async () => {
    // Review: the save's answer rebased the draft with the field "as sent"
    // standing in for the base, so a click made meanwhile (back to the base
    // value) read as no change and the person's value came back.
    await openStudio();
    fireEvent.change(traits(), { target: { value: 'silver hair, my words' } });
    outsideWrite({ frozenTraitString: 'silver hair, agent words' });
    await screen.findByRole('status', { name: /Claude also changed the frozen trait string/ });
    let land: () => void = () => {};
    const put = api.updateCharacter.getMockImplementation()!;
    api.updateCharacter.mockImplementationOnce(async (...args: Parameters<typeof put>) => {
      const answer = await put(...args);
      await new Promise<void>((resolve) => { land = resolve; });
      return answer;
    });
    await waitFor(() => expect(server.character.frozenTraitString).toBe('silver hair, my words'), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Use theirs' }));
    await act(async () => { land(); });
    await waitFor(() => expect(server.character.frozenTraitString).toBe('silver hair, agent words'), { timeout: 3000 });
    expect(traits().value).toBe('silver hair, agent words');
  });

  it('the note can be dismissed, and a change to the same value is no conflict', async () => {
    await openStudio();
    fireEvent.change(name(), { target: { value: 'Same' } });
    outsideWrite({ name: 'Same' });
    await waitFor(() => expect(api.fetchCharacter).toHaveBeenCalledTimes(2));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('status', { name: /also changed/ })).toBeNull();

    fireEvent.change(traits(), { target: { value: 'mine' } });
    outsideWrite({ frozenTraitString: 'theirs' }, { actor: { kind: 'person' } });
    await screen.findByRole('status', { name: /Another tab also changed the frozen trait string/ });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status', { name: /also changed/ })).toBeNull();
    expect(traits().value).toBe('mine');
  });

  it("this tab's own echo doesn't read the Character again", async () => {
    await openStudio();
    const reads = api.fetchCharacter.mock.calls.length;
    outsideWrite({ seed: 5 }, { tab: TAB_ID, actor: { kind: 'person' } });
    await act(async () => { await Promise.resolve(); });
    expect(api.fetchCharacter.mock.calls.length).toBe(reads);
  });

  it('a write made while the socket was down shows once it comes back', async () => {
    await openStudio();
    outsideWrite({ name: 'Renamed by Claude' }, { announce: false });
    expect(name().value).toBe('Nari');
    act(() => { for (const handler of socket.handlers) handler({ type: 'socketReconnected' }); });
    await waitFor(() => expect(name().value).toBe('Renamed by Claude'));
  });

  it('reopening a kept draft shows what changed while the Studio was closed', async () => {
    (await openStudio()).unmount();
    outsideWrite({ frozenTraitString: 'changed while closed' }, { announce: false });
    act(() => { useUIStore.getState().enterCharacterEditor('c1', 'global'); });
    render(<CharacterStudioView />);
    await waitFor(() => expect(traits().value).toBe('changed while closed'));
  });
});
