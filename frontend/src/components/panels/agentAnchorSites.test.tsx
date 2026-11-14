import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { Character, Moodboard } from '../../types';
import type { Preset } from '../../lib/createPresets';

// The DOM sites an agent cursor on the Assets dock, a Style card and the
// composer finds (lib/agentAnchors): each tab is its surface's launcher, each
// row its item's anchor and launcher, a Style card its anchor.
const api = vi.hoisted(() => ({ fetchMoodboards: vi.fn(), fetchCharacters: vi.fn(), moveStoredAsset: vi.fn() }));
vi.mock('../../lib/api', () => api);
const presets = vi.hoisted(() => ({ fetchPresets: vi.fn(), deletePreset: vi.fn() }));
vi.mock('../../lib/createPresets', () => presets);
const trash = vi.hoisted(() => ({ fetchTrash: vi.fn(), restoreTrashed: vi.fn(), purgeTrashed: vi.fn(), emptyTrash: vi.fn() }));
vi.mock('../../lib/trash', async (importOriginal) => ({ ...(await importOriginal<object>()), ...trash }));
vi.mock('../../lib/backend', async (importOriginal) => ({ ...(await importOriginal<object>()), backendAssetUrlSync: (url: string) => url }));
vi.mock('../../lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, connect: () => {}, send: () => {} } }));

import { AssetsPanel } from './AssetsPanel';
import { PresetCard } from '../create-studio/PresetCard';
import { CreateComposer } from '../create-studio/CreateComposer';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { setOpenProject } from '../../test/projectState';

const board = { id: 'b1', name: 'Warm editorial', thumbnail: '', images: [{}], mode: 'look' } as unknown as Moodboard;
const character = { id: 'c1', name: 'Nari', thumbnail: '', referenceViews: ['a', 'b', 'c'] } as unknown as Character;
const preset = (overrides: Partial<Preset> = {}): Preset => ({
  id: 's1', name: 'Dusk grain', category: 'Cinematic', prompt: 'grain', params: {}, modelId: null, refImages: [], thumbnail: '',
  version: 1, scope: 'global', projectId: null, createdAt: '', updatedAt: '', ...overrides,
}) as Preset;

beforeEach(() => {
  api.fetchMoodboards.mockReset().mockResolvedValue([board]);
  api.fetchCharacters.mockReset().mockResolvedValue([character]);
  api.moveStoredAsset.mockReset();
  presets.fetchPresets.mockReset().mockResolvedValue([preset()]);
  presets.deletePreset.mockReset();
  Object.values(trash).forEach((mock) => mock.mockReset());
  trash.fetchTrash.mockResolvedValue([]);
  useAssetStudioDraftStore.setState({ entries: {}, aliases: {} });
  setOpenProject(['pA', 'Shoot A'], []);
});
afterEach(() => cleanup());

const rowFor = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) }).closest('.assets-item')!;

describe('the Assets dock', () => {
  it('has each tab as the launcher for its own surface, and nothing else', () => {
    render(<ReactFlowProvider><AssetsPanel /></ReactFlowProvider>);
    const launcherOf = (name: string) => screen.getByRole('tab', { name }).getAttribute('data-agent-launcher');
    expect(launcherOf('Characters')).toBe('character');
    expect(launcherOf('Moodboards')).toBe('moodboard');
    expect(launcherOf('Styles')).toBe('style');
    expect(document.querySelectorAll('[data-agent-launcher]')).toHaveLength(3);
  });

  it.each([
    { tab: 'Characters', item: 'Nari', anchor: 'character:c1' },
    { tab: 'Moodboards', item: 'Warm editorial', anchor: 'moodboard:b1' },
    { tab: 'Styles', item: 'Dusk grain', anchor: 'style:s1' },
  ])('a $tab row is its item\'s anchor and launcher', async ({ tab, item, anchor }) => {
    render(<ReactFlowProvider><AssetsPanel /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('tab', { name: tab }));
    await screen.findByRole('button', { name: new RegExp(`^${item}`) });
    const row = rowFor(item);
    expect(row.getAttribute('data-agent-anchor')).toBe(anchor);
    expect(row.getAttribute('data-agent-launcher')).toBe(anchor);
  });

  it('a row with an id outside the attribute grammar carries neither, so no selector is built from it', async () => {
    presets.fetchPresets.mockResolvedValue([preset({ id: 'has space' })]);
    render(<ReactFlowProvider><AssetsPanel /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('tab', { name: 'Styles' }));
    await screen.findByRole('button', { name: /^Dusk grain/ });
    const row = rowFor('Dusk grain');
    expect(row.hasAttribute('data-agent-anchor')).toBe(false);
    expect(row.hasAttribute('data-agent-launcher')).toBe(false);
  });
});

describe('Create', () => {
  it('a Style card in the popover is the style\'s anchor', () => {
    const { container } = render(<PresetCard preset={preset()} onApply={() => {}} />);
    expect(container.querySelector('button.preset-card')!.getAttribute('data-agent-anchor')).toBe('style:s1');
  });

  it('the composer\'s Styles button is the style launcher', () => {
    render(<CreateComposer modelDef={NODE_DEFINITIONS['krea-image-openai-gpt-image-2']}
      prompt="a logo" params={{}} activeCount={0} maxConcurrent={2} quantity={1}
      onPromptChange={vi.fn()} onSelectModel={vi.fn()} onParamsChange={vi.fn()}
      onGenerate={vi.fn()} onAttach={vi.fn()} onQuantityChange={vi.fn()} onOpenStyles={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Styles' }).getAttribute('data-agent-launcher')).toBe('style');
    expect(document.querySelectorAll('[data-agent-launcher]')).toHaveLength(1);
  });
});
