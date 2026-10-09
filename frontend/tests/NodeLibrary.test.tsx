import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { NodeLibrary } from '../src/components/panels/NodeLibrary';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };
const INITIAL_UI_STATE = { ...useUIStore.getState() };

function renderLibrary() {
  return render(<ReactFlowProvider><NodeLibrary /></ReactFlowProvider>);
}

function browseType(label: string) {
  fireEvent.click(screen.getByRole('button', { name: `Browse ${label} nodes` }));
}

function browseAll() {
  fireEvent.click(screen.getByRole('button', { name: 'Search all models' }));
}

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

  afterEach(() => vi.restoreAllMocks());

  it('starts with compact native type buttons and direct search without hidden model controls', () => {
    renderLibrary();
    for (const label of ['Image', 'Video', 'Audio', 'Text', 'Import', '3D', 'Workflow', 'Tools']) {
      const button = screen.getByRole('button', { name: `Browse ${label} nodes` });
      expect(button.tagName).toBe('BUTTON');
      expect(button).toHaveAttribute('type', 'button');
      expect(button).toBeEnabled();
    }
    expect(screen.getByRole('textbox', { name: 'Search nodes' }))
      .toHaveAttribute('placeholder', 'Search all models and tools…');
    expect(screen.getByRole('button', { name: 'Search all models' })).toBeEnabled();
    expect(screen.queryByRole('combobox', { name: 'Node provider' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'GPT Image 2', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Text Input', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Paper Source', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connection settings for GPT Image 2', hidden: true }))
      .not.toBeInTheDocument();
  });

  it('exposes node definitions as focusable buttons with click-to-add behavior', () => {
    const addNode = vi.fn(async () => 'n1');
    useGraphStore.setState({ addNode });

    render(
      <ReactFlowProvider>
        <NodeLibrary />
      </ReactFlowProvider>,
    );
    browseType('Text');

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
    browseType('Text');

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
    browseAll();
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
    browseAll();
    const search = screen.getByRole('textbox', { name: 'Search nodes' });
    const provider = screen.getByRole('combobox', { name: 'Node provider' });
    fireEvent.change(provider, { target: { value: 'anthropic' } });
    fireEvent.change(search, { target: { value: 'unavailableword' } });
    expect(screen.getByRole('status')).toHaveTextContent('No nodes match “unavailableword” from Anthropic.');
    const suggestion = screen.getByRole('button', { name: 'Animate a logo' });
    suggestion.focus();
    fireEvent.click(suggestion);
    expect(provider).toHaveValue('');
    expect(search).toHaveValue('Animate a logo');
    expect(search).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Kling 3.0 (Krea)' })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'unavailableword' } });
    const clear = screen.getByRole('button', { name: 'Clear filters' });
    clear.focus();
    fireEvent.click(clear);
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
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
    browseAll();
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

  it('browses a media type without choosing a default model or running anything', () => {
    const addNode = vi.fn();
    const executeGraph = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch');
    useGraphStore.setState({ addNode, executeGraph });
    const cache = { apiKeys: {}, loaded: true };
    useUIStore.setState({ settingsCache: cache });
    const graph = useGraphStore.getState();
    renderLibrary();

    browseType('Image');
    expect(screen.getByRole('button', { name: 'Back to node types' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'GPT Image 2' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: /^Image Generation/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: 'Kling 3.0 (Krea)' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Paper Source' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Text Input' })).not.toBeInTheDocument();
    expect(addNode).not.toHaveBeenCalled();
    expect(executeGraph).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(useGraphStore.getState().nodes).toBe(graph.nodes);
    expect(useGraphStore.getState().edges).toBe(graph.edges);
    expect(useUIStore.getState().settingsCache).toBe(cache);

    fireEvent.click(screen.getByRole('button', { name: 'GPT Image 2' }));
    expect(addNode).toHaveBeenCalledOnce();
    expect(addNode).toHaveBeenCalledWith('gpt-image-2-generate', expect.any(Object));
    expect(executeGraph).not.toHaveBeenCalled();
  });

  it('offers linked and uploaded sources under Import separately from generation models', () => {
    const addNode = vi.fn();
    const executeGraph = vi.fn();
    useGraphStore.setState({ addNode, executeGraph });
    renderLibrary();
    browseType('Import');

    for (const name of ['Paper Source', 'Image Input', 'Video Input', 'Audio Input', 'Document Input', 'Style Reference']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
    expect(screen.queryByRole('button', { name: 'Text Input' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'GPT Image 2' })).not.toBeInTheDocument();
    expect(addNode).not.toHaveBeenCalled();
    expect(executeGraph).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Paper Source' }));
    expect(addNode).toHaveBeenCalledWith('paper-source', expect.any(Object));
    expect(executeGraph).not.toHaveBeenCalled();
  });

  it.each([
    ['3D', ['Meshy 6 Text-to-3D', 'World Labs Environment', 'World Labs Export']],
    ['Workflow', ['Batch', 'Router', 'Reroute', 'Array Builder']],
    ['Tools', ['FAL', 'Character', 'Moodboard', 'Camera Rig', 'Preview']],
  ] as const)('keeps %s nodes directly reachable from the compact menu', (type, names) => {
    const addNode = vi.fn();
    const executeGraph = vi.fn();
    useGraphStore.setState({ addNode, executeGraph });
    renderLibrary();
    browseType(type);
    for (const name of names) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
    expect(screen.queryByRole('button', { name: 'Paper Source' })).not.toBeInTheDocument();
    expect(addNode).not.toHaveBeenCalled();
    expect(executeGraph).not.toHaveBeenCalled();
  });

  it('direct search spans types, and clearing a home search returns to the compact menu', () => {
    const addNode = vi.fn();
    const executeGraph = vi.fn();
    useGraphStore.setState({ addNode, executeGraph });
    renderLibrary();
    const search = screen.getByRole('textbox', { name: 'Search nodes' });

    fireEvent.change(search, { target: { value: 'Paper' } });
    expect(screen.getByRole('button', { name: 'Paper Source' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Node provider' })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'GPT Image 2' } });
    expect(screen.getByRole('button', { name: 'GPT Image 2' })).toBeEnabled();
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Browse Import nodes' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Node provider' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'GPT Image 2', hidden: true })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'unavailableword' } });
    const clear = screen.getByRole('button', { name: 'Clear filters' });
    clear.focus();
    fireEvent.click(clear);
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Browse Import nodes' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Node provider' })).not.toBeInTheDocument();
    expect(addNode).not.toHaveBeenCalled();
    expect(executeGraph).not.toHaveBeenCalled();
  });

  it('retains the selected type when clearing filters and restores the type opener on Back', () => {
    const addNode = vi.fn();
    const executeGraph = vi.fn();
    useGraphStore.setState({ addNode, executeGraph });
    renderLibrary();
    browseType('Video');
    const search = screen.getByRole('textbox', { name: 'Search nodes' });
    const provider = screen.getByRole('combobox', { name: 'Node provider' });

    fireEvent.change(provider, { target: { value: 'anthropic' } });
    fireEvent.change(search, { target: { value: 'unavailableword' } });
    const clear = screen.getByRole('button', { name: 'Clear filters' });
    clear.focus();
    fireEvent.click(clear);
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(provider).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Kling 3.0 (Krea)' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'GPT Image 2' })).not.toBeInTheDocument();
    fireEvent.change(provider, { target: { value: 'krea' } });
    fireEvent.change(search, { target: { value: 'Kling' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back to node types' }));
    expect(search).toHaveValue('');
    expect(screen.queryByRole('combobox', { name: 'Node provider' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse Video nodes' })).toHaveFocus();
    expect(addNode).not.toHaveBeenCalled();
    expect(executeGraph).not.toHaveBeenCalled();
  });

  it('lets a scoped category collapse, then expands a newly searched context without changing saved preferences', () => {
    const addNode = vi.fn();
    const executeGraph = vi.fn();
    useGraphStore.setState({ addNode, executeGraph });
    renderLibrary();
    const preferences = useUIStore.getState().libraryCollapsed;
    browseType('Image');

    const category = screen.getByRole('button', { name: /^Image Generation/ });
    expect(category).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(category);
    expect(category).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'GPT Image 2' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connection settings for GPT Image 2' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search nodes' }), { target: { value: 'GPT Image 2' } });
    expect(screen.getByRole('button', { name: /^Image Generation/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'GPT Image 2' })).toHaveAttribute('tabindex', '0');
    expect(useUIStore.getState().libraryCollapsed).toBe(preferences);
    expect(addNode).not.toHaveBeenCalled();
    expect(executeGraph).not.toHaveBeenCalled();
  });

  it('uses Escape to return to types and restore focus without closing the panel or bubbling to canvas shortcuts', () => {
    const parentKeyDown = vi.fn();
    const addNode = vi.fn();
    const executeGraph = vi.fn();
    useGraphStore.setState({ addNode, executeGraph });
    render(<div onKeyDown={parentKeyDown}><ReactFlowProvider><NodeLibrary /></ReactFlowProvider></div>);
    browseType('Video');
    const search = screen.getByRole('textbox', { name: 'Search nodes' });
    fireEvent.change(search, { target: { value: 'Kling' } });

    expect(fireEvent.keyDown(search, { key: 'Escape' })).toBe(false);
    expect(screen.getByRole('button', { name: 'Browse Video nodes' })).toHaveFocus();
    expect(search).toHaveValue('');
    expect(useUIStore.getState().panels.library.visible).toBe(true);
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(addNode).not.toHaveBeenCalled();
    expect(executeGraph).not.toHaveBeenCalled();
  });

  it('searches all models from a type without losing query or provider and focuses search', () => {
    renderLibrary();
    browseType('Image');
    const search = screen.getByRole('textbox', { name: 'Search nodes' });
    const provider = screen.getByRole('combobox', { name: 'Node provider' });
    fireEvent.change(provider, { target: { value: 'krea' } });
    fireEvent.change(search, { target: { value: 'Kling' } });
    expect(screen.queryByRole('button', { name: 'Kling 3.0 (Krea)' })).not.toBeInTheDocument();

    browseAll();
    expect(search).toHaveValue('Kling');
    expect(provider).toHaveValue('krea');
    expect(search).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Kling 3.0 (Krea)' })).toBeEnabled();
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getByRole('combobox', { name: 'Node provider' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to node types' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to node types' }));
    expect(screen.getByRole('button', { name: 'Search all models' })).toHaveFocus();
  });

  it('keeps explicit all-model browsing after clearing filters without choosing a node', () => {
    const addNode = vi.fn();
    const executeGraph = vi.fn();
    useGraphStore.setState({ addNode, executeGraph });
    renderLibrary();
    browseAll();
    const search = screen.getByRole('textbox', { name: 'Search nodes' });
    const provider = screen.getByRole('combobox', { name: 'Node provider' });
    fireEvent.change(provider, { target: { value: 'anthropic' } });
    fireEvent.change(search, { target: { value: 'unavailableword' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(search).toHaveValue('');
    expect(provider).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Paper Source' })).toBeEnabled();
    const images = screen.getByRole('button', { name: /^Image Generation/ });
    expect(useUIStore.getState().libraryCollapsed).not.toHaveProperty('image-gen');
    expect(images).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(images);
    expect(images).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'GPT Image 2' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Back to node types' })).toBeEnabled();
    expect(addNode).not.toHaveBeenCalled();
    expect(executeGraph).not.toHaveBeenCalled();
  });
});
