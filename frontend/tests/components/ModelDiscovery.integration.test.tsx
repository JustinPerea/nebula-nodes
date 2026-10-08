import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ModelPicker } from '../../src/components/create-studio/ModelPicker';
import { CreateComposer } from '../../src/components/create-studio/CreateComposer';
import { NODE_DEFINITIONS } from '../../src/constants/nodeDefinitions';
import { useUIStore } from '../../src/store/uiStore';
import { useGraphStore } from '../../src/store/graphStore';
import { useCreateDraftStore } from '../../src/store/createDraftStore';
import { useProviderReadinessStore } from '../../src/store/providerReadinessStore';

const ui = useUIStore.getState();
const graph = useGraphStore.getState();
const drafts = useCreateDraftStore.getState();
const model = NODE_DEFINITIONS['krea-image-openai-gpt-image-2'];

beforeEach(() => {
  useUIStore.setState(ui, true); useGraphStore.setState(graph, true);
  useProviderReadinessStore.getState().invalidate();
  useUIStore.setState({ viewMode: 'create', createSessionId: 'discovery-test',
    settingsCache: { apiKeys: {}, loaded: true, kreaConnectionMode: 'api-token', kreaConnection: { status: 'connected' } } });
});
afterEach(() => {
  cleanup(); useProviderReadinessStore.getState().invalidate();
  useUIStore.setState(ui, true); useGraphStore.setState(graph, true);
  useCreateDraftStore.setState(drafts, true); vi.restoreAllMocks();
});

describe('Model discovery and setup continuity', () => {
  it('finds logo animation routes from real catalog ports without generating', () => {
    const onSelect = vi.fn(); const onClose = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch');
    render(<ModelPicker value={null} onSelect={onSelect} onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'animate a logo' } });
    expect(screen.getByRole('button', { name: 'Kling 3.0 (Krea), Video Generation, Krea' })).toBeInTheDocument();
    expect(screen.getAllByText(/Start image/).length).toBeGreaterThan(0);
    expect(onSelect).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('opens the exact API setup from a picker row without selecting it or changing the draft/graph', () => {
    const seed = { modelId: model.id, prompt: 'Keep this logo draft', params: { _kreaAuth: 'mcp', seed: 88 }, refs: [], quantity: 2 };
    const draft = useCreateDraftStore.getState().getOrCreateDraft('discovery-test', seed);
    const before = useGraphStore.getState();
    const onSelect = vi.fn(); const onClose = vi.fn(); const fetch = vi.spyOn(globalThis, 'fetch');
    render(<ModelPicker value={model.id} selectedParams={seed.params} onSelect={onSelect} onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'gpt image' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings for GPT Image 1' }));
    expect(onClose).toHaveBeenCalledOnce(); expect(onSelect).not.toHaveBeenCalled();
    expect(useUIStore.getState().settingsProviderTarget).toEqual({ kind: 'api-key', key: 'OPENAI_API_KEY' });
    expect(useUIStore.getState().viewMode).toBe('create');
    expect(useCreateDraftStore.getState().drafts['discovery-test']).toBe(draft);
    expect(useGraphStore.getState().nodes).toBe(before.nodes);
    expect(useGraphStore.getState().edges).toBe(before.edges);
    expect(useGraphStore.getState().runHistory).toBe(before.runHistory);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows selected recipe sign-in mode while other Krea rows use the new-node default', () => {
    render(<ModelPicker value={model.id} selectedParams={{ _kreaAuth: 'mcp' }} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Model provider' }), { target: { value: 'krea' } });
    const selected = screen.getByRole('button', { name: 'GPT Image 2 (Krea), Image Generation, Krea' }).parentElement!;
    expect(selected).toHaveTextContent('Krea signed in');
    const original = screen.getByRole('button', { name: 'Krea 2, Image Generation, Krea' }).parentElement!;
    expect(original).toHaveTextContent('Setup required');
    expect(useUIStore.getState().settingsCache.kreaConnectionMode).toBe('api-token');
  });

  it('updates Create readiness without changing parameters, model or invoking generation', () => {
    const params = { _kreaAuth: 'api-token', seed: 88 };
    const onGenerate = vi.fn(); const onParamsChange = vi.fn(); const onSelectModel = vi.fn();
    render(<CreateComposer modelDef={model} prompt="Keep this draft" params={params} activeCount={0} maxConcurrent={2} quantity={2}
      onPromptChange={vi.fn()} onSelectModel={onSelectModel} onParamsChange={onParamsChange} onGenerate={onGenerate}
      onAttach={vi.fn()} onQuantityChange={vi.fn()} onOpenStyles={vi.fn()} />);
    expect(screen.getByText('Setup required')).toBeInTheDocument();
    act(() => useUIStore.getState().setSettingsCache({ KREA_API_TOKEN: '***configured***' }, 'mcp'));
    expect(screen.getByText('Configured · not checked')).toBeInTheDocument();
    expect(params).toEqual({ _kreaAuth: 'api-token', seed: 88 });
    expect(onGenerate).not.toHaveBeenCalled(); expect(onParamsChange).not.toHaveBeenCalled(); expect(onSelectModel).not.toHaveBeenCalled();
  });
});
