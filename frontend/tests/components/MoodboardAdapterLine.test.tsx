import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node, NodeProps } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import handTable from '../../../backend/data/moodboard_adapters.json';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { useGraphStore } from '../../src/store/graphStore';
import { useMoodboardAdapterStore } from '../../src/store/moodboardAdapterStore';
import { useUIStore } from '../../src/store/uiStore';
import type { AdapterTable } from '../../src/lib/moodboardAdapters';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

function node(id: string, definitionId: string): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId, label: definitionId, params: {}, state: 'idle', outputs: {} } };
}
const wire = (target: string, targetHandle = 'moodboard'): Edge => ({
  id: `b-${target}-${targetHandle}`, source: 'board', sourceHandle: 'moodboard', target, targetHandle });

function renderCard(id: string, definitionId: string, edges: Edge[]) {
  const card = node(id, definitionId);
  useGraphStore.setState({ nodes: [node('board', 'nebula-moodboard'), card], edges });
  return render(<ModelNode {...({ id, data: card.data, selected: false } as NodeProps)} />);
}

beforeEach(() => {
  useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
  useMoodboardAdapterStore.setState({ entries: handTable.entries as unknown as AdapterTable, loading: false, failed: false });
});

describe('the Moodboard line on a node card', () => {
  it('says what a wired board does there', async () => {
    renderCard('g', 'gpt-image-2-edit', [wire('g')]);
    expect(await screen.findByText('Board images: off · the brief goes as text')).toBeInTheDocument();
  });

  it('says a text-only model takes the brief as text, and Krea 2 sends board images', async () => {
    const { unmount } = renderCard('t', 'gpt-image-2-generate', [wire('t')]);
    expect(await screen.findByText('This model takes the brief as text.')).toBeInTheDocument();
    unmount();
    renderCard('k', 'krea-2-generate', [wire('k')]);
    expect(await screen.findByText('Board images: on · up to 10 to Image Style Refs')).toBeInTheDocument();
  });

  it('shows nothing until a board is wired into the Moodboard port', () => {
    const { container } = renderCard('g', 'gpt-image-2-edit', [wire('g', 'prompt')]);
    expect(container.querySelector('.model-node__board-line')).toBeNull();
    expect(screen.queryByText(/Board images|takes the brief/)).toBeNull();
  });

  it('says nothing about board images when the wire into Krea 2 is a Krea moodboard, not a Nebula board', async () => {
    // Krea's Moodboard node outputs Any and still wires into Krea 2's
    // Moodboard port; the handler sends it as a Krea moodboard id, so no
    // board images go and the line would be wrong.
    const card = node('k', 'krea-2-generate');
    useGraphStore.setState({ nodes: [node('kmb', 'krea-moodboard'), node('id', 'text-input'), card],
      edges: [{ id: 'e1', source: 'kmb', sourceHandle: 'moodboard', target: 'k', targetHandle: 'moodboard' }] });
    const { container, unmount } = render(
      <ModelNode {...({ id: 'k', data: card.data, selected: false } as NodeProps)} />);
    expect(container.querySelector('.model-node__board-line')).toBeNull();
    unmount();
    // A saved project's old Text wire (Krea 2's port was Any before PR13): the run refuses it.
    useGraphStore.setState({
      edges: [{ id: 'e2', source: 'id', sourceHandle: 'text', target: 'k', targetHandle: 'moodboard' }] });
    const second = render(<ModelNode {...({ id: 'k', data: card.data, selected: false } as NodeProps)} />);
    expect(second.container.querySelector('.model-node__board-line')).toBeNull();
  });

  it('follows a Nebula board through a reroute', async () => {
    const card = node('g', 'gpt-image-2-edit');
    useGraphStore.setState({ nodes: [node('board', 'nebula-moodboard'), node('r', 'reroute'), card], edges: [
      { id: 'e1', source: 'board', sourceHandle: 'moodboard', target: 'r', targetHandle: 'input' },
      { id: 'e2', source: 'r', sourceHandle: 'output', target: 'g', targetHandle: 'moodboard' }] });
    render(<ModelNode {...({ id: 'g', data: card.data, selected: false } as NodeProps)} />);
    expect(await screen.findByText('Board images: off · the brief goes as text')).toBeInTheDocument();
  });

  it('holds the line\'s place while the table loads, then fills it in', async () => {
    useMoodboardAdapterStore.setState({ entries: null, loading: true, failed: false });
    const { container } = renderCard('g', 'gpt-image-2-edit', [wire('g')]);
    const placeholder = await vi.waitFor(() => {
      const element = container.querySelector('.model-node__board-line');
      if (!element) throw new Error('no line yet');
      return element;
    });
    expect(placeholder.textContent).toBe('');
    useMoodboardAdapterStore.setState({ entries: handTable.entries as unknown as AdapterTable, loading: false });
    expect(await screen.findByText('Board images: off · the brief goes as text')).toBeInTheDocument();
  });

  it('draws no line when the table could not load', async () => {
    const { load } = useMoodboardAdapterStore.getState();
    useMoodboardAdapterStore.setState({ entries: null, loading: false, failed: true, load: async () => {} });
    const { container, unmount } = renderCard('g', 'gpt-image-2-edit', [wire('g')]);
    try {
      await vi.waitFor(() => {
        if (container.querySelector('.model-node__board-line')) throw new Error('still the placeholder');
      });
      expect(screen.queryByText(/Board images|takes the brief/)).toBeNull();
    } finally {
      // Unmount first: a card still mounted would load again with the real load.
      unmount();
      useMoodboardAdapterStore.setState({ load });
    }
  });
});
