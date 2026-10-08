import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { NodeLibrary } from '../src/components/panels/NodeLibrary';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };

describe('NodeLibrary accessible authoring', () => {
  beforeEach(() => {
    cleanup();
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    useUIStore.setState(INITIAL_UI_STATE, true);
    useUIStore.setState((state) => ({
      libraryCollapsed: { __nebulaLibraryInit: true, utility: false },
      panels: {
        ...state.panels,
        library: { ...state.panels.library, visible: true },
      },
    }));
  });

  it('exposes node definitions as focusable buttons with click-to-add behavior', () => {
    const addNode = vi.fn(async () => 'n1');
    useGraphStore.setState({ addNode });

    render(
      <ReactFlowProvider>
        <NodeLibrary />
      </ReactFlowProvider>,
    );

    const textInput = screen.getByRole('button', { name: 'Text Input' });
    expect(textInput).toHaveAttribute('draggable', 'true');
    expect(textInput).toHaveAttribute('tabindex', '0');

    textInput.focus();
    fireEvent.keyDown(textInput, { key: 'Enter' });
    fireEvent.click(textInput);
    fireEvent.click(textInput, { detail: 2 });

    expect(addNode).toHaveBeenCalledOnce();
    expect(addNode).toHaveBeenCalledWith(
      'text-input',
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
  }, 15_000);

  it('reserves distinct open slots for rapid accessible additions', () => {
    const addNode = vi.fn(async () => 'n1');
    useGraphStore.setState({ addNode, nodes: [] });

    render(
      <ReactFlowProvider>
        <NodeLibrary />
      </ReactFlowProvider>,
    );

    const textInput = screen.getByRole('button', { name: 'Text Input' });
    fireEvent.click(textInput);
    fireEvent.click(textInput);
    fireEvent.click(textInput);

    const positions = addNode.mock.calls.map((call) => call[1]);
    expect(positions).toHaveLength(3);
    expect(new Set(positions.map((position) => `${position.x}:${position.y}`))).toHaveProperty('size', 3);
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        expect(
          Math.abs(positions[i].x - positions[j].x) >= 320
          || Math.abs(positions[i].y - positions[j].y) >= 220,
        ).toBe(true);
      }
    }
  });

  it('finds task terms and describes inputs without adding or generating', () => {
    const addNode = vi.fn(async () => 'n1');
    const executeGraph = vi.fn();
    useGraphStore.setState({ addNode, executeGraph });
    const graph = useGraphStore.getState();
    render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search nodes' }), { target: { value: 'animate a logo' } });
    const kling = screen.getByRole('button', { name: 'Kling 3.0 (Krea)' });
    expect(kling).toHaveAttribute('tabindex', '0');
    expect(kling).toHaveAccessibleDescription(/Start image \(optional\).*End image \(optional\).*Video/);
    expect(addNode).not.toHaveBeenCalled();
    expect(executeGraph).not.toHaveBeenCalled();
    expect(useGraphStore.getState().nodes).toBe(graph.nodes);
    expect(useGraphStore.getState().edges).toBe(graph.edges);
    fireEvent.click(kling);
    expect(addNode).toHaveBeenCalledWith('krea-video-kling-kling-3-0', expect.any(Object));
    expect(executeGraph).not.toHaveBeenCalled();
  });

  it('filters providers, expands matching categories and retains search while switching routes', () => {
    render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
    const provider = screen.getByRole('combobox', { name: 'Node provider' });
    const search = screen.getByRole('textbox', { name: 'Search nodes' });
    fireEvent.change(search, { target: { value: 'GPT Image' } });
    fireEvent.change(provider, { target: { value: 'krea' } });
    expect(screen.getByRole('button', { name: 'GPT Image 2 (Krea)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'GPT Image 1' })).not.toBeInTheDocument();
    fireEvent.change(provider, { target: { value: 'openai' } });
    expect(search).toHaveValue('GPT Image');
    expect(screen.getByRole('button', { name: 'GPT Image 1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'GPT Image 2 (Krea)' })).not.toBeInTheDocument();
  });

  it('explains empty searches and offers working task recovery and filter reset', () => {
    const addNode = vi.fn();
    useGraphStore.setState({ addNode });
    render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
    const search = screen.getByRole('textbox', { name: 'Search nodes' });
    const provider = screen.getByRole('combobox', { name: 'Node provider' });
    fireEvent.change(provider, { target: { value: 'anthropic' } });
    fireEvent.change(search, { target: { value: 'unavailableword' } });
    expect(screen.getByRole('status')).toHaveTextContent('No nodes match “unavailableword” from Anthropic.');
    fireEvent.click(screen.getByRole('button', { name: 'Animate a logo' }));
    expect(provider).toHaveValue('');
    expect(search).toHaveValue('Animate a logo');
    expect(screen.getByRole('button', { name: 'Kling 3.0 (Krea)' })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'unavailableword' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(search).toHaveValue('');
    expect(provider).toHaveValue('');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^3D Generation/ })).toBeInTheDocument();
    expect(addNode).not.toHaveBeenCalled();
  });

  it('keeps models browsable with no configured keys and shows friendly 3D labels', () => {
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search nodes' }), { target: { value: '3D generation' } });
    expect(screen.getByRole('button', { name: /^3D Generation/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Meshy 6 Text-to-3D' })).toBeEnabled();
    expect(screen.queryByText(/^3d-gen$/)).not.toBeInTheDocument();
  });

  it('opens separate setup without adding a node or checking providers and removes collapsed setup controls', () => {
    const addNode = vi.fn();
    const executeGraph = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch');
    useGraphStore.setState({ addNode, executeGraph });
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
    expect(screen.queryByRole('button', { name: 'Connection settings for GPT Image 2' })).not.toBeInTheDocument();
    const search = screen.getByRole('textbox', { name: 'Search nodes' });
    fireEvent.change(search, { target: { value: 'GPT Image 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connection settings for GPT Image 2' }));
    expect(useUIStore.getState().settingsProviderTarget).toEqual({ kind: 'api-key', key: 'OPENAI_API_KEY' });
    expect(addNode).not.toHaveBeenCalled();
    expect(executeGraph).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it('finds dual-route models under either supported provider without changing graph or credentials', () => {
    const executeGraph = vi.fn(); const addNode = vi.fn();
    useGraphStore.setState({ executeGraph, addNode });
    const cache = { apiKeys: {}, loaded: true };
    useUIStore.setState({ settingsCache: cache });
    render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
    const provider = screen.getByRole('combobox', { name: 'Node provider' });
    expect(screen.getByRole('option', { name: 'Meshy' })).toHaveValue('meshy');
    fireEvent.change(provider, { target: { value: 'fal' } });
    expect(screen.getByRole('button', { name: 'Veo 3.1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Meshy 6 Text-to-3D' })).toBeEnabled();
    fireEvent.change(provider, { target: { value: 'meshy' } });
    expect(screen.getByRole('button', { name: 'Meshy 6 Text-to-3D' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Veo 3.1' })).not.toBeInTheDocument();
    expect(useUIStore.getState().settingsCache).toBe(cache);
    expect(executeGraph).not.toHaveBeenCalled(); expect(addNode).not.toHaveBeenCalled();
  });
});
