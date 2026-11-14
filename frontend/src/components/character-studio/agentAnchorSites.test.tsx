import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Character } from '../../types';

// The DOM sites an agent cursor on a Character finds (lib/agentAnchors): the
// Studio's definition panel and its controls, each reference view by
// position, the rail's rows; none of them for an unsaved draft.
const api = vi.hoisted(() => ({
  createCharacter: vi.fn(), fetchCharacter: vi.fn(), fetchCharacters: vi.fn(),
  lookupStoredAsset: vi.fn(), moveStoredAsset: vi.fn(), updateCharacter: vi.fn(),
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
import { CharacterDefinitionPanel } from './CharacterDefinitionPanel';
import { useUIStore } from '../../store/uiStore';
import { useStudioCharacterStore } from '../../store/studioCharacterStore';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { setOpenProject } from '../../test/projectState';

const nari = {
  id: 'c1', name: 'Nari', version: 1, subjectType: 'human', referenceViews: ['/a.png', '/b.png', '/c.png'],
  frozenTraitString: 'silver hair', seed: 1, consistencyStrength: 0.8, thumbnail: '/a.png',
  projectId: undefined, createdAt: '', updatedAt: '',
} as unknown as Character;

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.fetchCharacter.mockImplementation(async (id: string) => (id === 'c1' ? nari : null));
  api.fetchCharacters.mockResolvedValue([nari]);
  api.updateCharacter.mockImplementation(async (_id: string, body: Partial<Character>) => ({ ...nari, ...body }));
  api.lookupStoredAsset.mockResolvedValue({ status: 'missing' });
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  useStudioCharacterStore.getState().setStudioCharacter(null);
  setOpenProject(['p1', 'Project'], []);
});
afterEach(() => cleanup());

const anchors = (root: ParentNode) => [...root.querySelectorAll('[data-agent-anchor]')].map((el) => el.getAttribute('data-agent-anchor'));
const ownAnchors = () => anchors(document.querySelector('.character-def')!)
  .concat(document.querySelector('.character-def')!.getAttribute('data-agent-anchor'));

describe('the open saved Character in the Studio', () => {
  it('is an anchor, with its controls and each reference view by 1-based position', async () => {
    act(() => { useUIStore.getState().enterCharacterEditor('c1', 'global'); });
    render(<CharacterStudioView />);
    await screen.findByDisplayValue('Nari');
    const panel = document.querySelector('.character-def')!;
    expect(panel.getAttribute('data-agent-anchor')).toBe('character:c1');
    expect(anchors(panel)).toEqual([
      'character:c1:name', 'character:c1:subject-type', 'character:c1:views',
      'character:c1/1', 'character:c1/2', 'character:c1/3', 'character:c1:traits', 'character:c1:seed',
    ]);
    // Each control sits on the label that is visible for it.
    const on = (part: string) => panel.querySelector(`[data-agent-anchor="character:c1:${part}"]`)!.textContent ?? '';
    expect(on('name')).toContain('Name');
    expect(on('subject-type')).toContain('Subject type');
    expect(on('views')).toContain('Reference views');
    expect(on('traits')).toContain('Frozen trait string');
    expect(on('seed')).toContain('Seed');
    // Consistency strength is not pointable: the nearest anchor around it is the Character itself.
    expect(panel.querySelector('input[type="range"]')!.closest('[data-agent-anchor]')).toBe(panel);
    // The rail's row for it.
    expect(document.querySelector('.character-rail__item')!.getAttribute('data-agent-anchor')).toBe('character:c1');
  });

  it('publishes its id and view count, which follows a removed view, and clears them on leaving', async () => {
    act(() => { useUIStore.getState().enterCharacterEditor('c1', 'global'); });
    const view = render(<CharacterStudioView />);
    await screen.findByDisplayValue('Nari');
    await waitFor(() => expect(useStudioCharacterStore.getState().studioCharacter).toEqual({ characterId: 'c1', viewCount: 3 }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove reference view' })[2]);
    await waitFor(() => expect(useStudioCharacterStore.getState().studioCharacter).toEqual({ characterId: 'c1', viewCount: 2 }));
    view.unmount();
    expect(useStudioCharacterStore.getState().studioCharacter).toBeNull();
  });
});

describe('an unsaved draft', () => {
  it('carries no anchor and publishes nothing', async () => {
    act(() => { useUIStore.getState().enterCharacterEditor('new', 'global'); });
    render(<CharacterStudioView />);
    await screen.findByPlaceholderText('e.g. Captain Vega');
    const panel = document.querySelector('.character-def')!;
    expect(ownAnchors().filter(Boolean)).toEqual([]);
    expect(panel.querySelector('[data-agent-anchor]')).toBeNull();
    expect(useStudioCharacterStore.getState().studioCharacter).toBeNull();
  });

  it('the panel on its own carries none without an id, and an unfit id gets none', () => {
    const draft = { name: '', subjectType: 'human' as const, referenceViews: ['/a.png'], frozenTraitString: '', seed: 0, consistencyStrength: 0.8 };
    const { container, rerender } = render(<CharacterDefinitionPanel draft={draft} thumbnail="" onChange={() => {}} />);
    expect(container.querySelector('[data-agent-anchor]')).toBeNull();
    rerender(<CharacterDefinitionPanel draft={draft} thumbnail="" onChange={() => {}} agentId="has space" />);
    expect(container.querySelector('[data-agent-anchor]')).toBeNull();
    rerender(<CharacterDefinitionPanel draft={draft} thumbnail="" onChange={() => {}} agentId="c9" />);
    expect(container.querySelector('.character-def')!.getAttribute('data-agent-anchor')).toBe('character:c9');
  });
});
