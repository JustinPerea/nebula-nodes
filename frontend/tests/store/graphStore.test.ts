import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock WebSocket for jsdom
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: {
    connect: vi.fn(),
    subscribe: vi.fn(),
    disconnect: vi.fn(),
  },
}));

// Mock fetch for api.ts
globalThis.fetch = vi.fn();

import { useGraphStore } from '../../src/store/graphStore';

describe('graphStore', () => {
  beforeEach(() => {
    useGraphStore.setState({ nodes: [], edges: [] });
  });

  it('starts with empty nodes and edges', () => {
    const state = useGraphStore.getState();
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
  });

  it('adds a node', () => {
    const { addNode } = useGraphStore.getState();
    addNode('gpt-image-1-generate', { x: 100, y: 200 });

    const { nodes } = useGraphStore.getState();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe('model-node');
    expect(nodes[0].position).toEqual({ x: 100, y: 200 });
    expect(nodes[0].data.definitionId).toBe('gpt-image-1-generate');
    expect(nodes[0].data.label).toBe('GPT Image 1');
    expect(nodes[0].data.state).toBe('idle');
  });

  it('removes a node and cleans up connected edges', () => {
    const { addNode } = useGraphStore.getState();
    addNode('text-input', { x: 0, y: 0 });
    addNode('gpt-image-1-generate', { x: 300, y: 0 });

    const { nodes } = useGraphStore.getState();
    const sourceId = nodes[0].id;
    const targetId = nodes[1].id;

    useGraphStore.setState((state) => ({
      edges: [
        ...state.edges,
        {
          id: 'test-edge',
          source: sourceId,
          sourceHandle: 'text',
          target: targetId,
          targetHandle: 'prompt',
          type: 'typed-edge',
          data: { dataType: 'Text' },
        },
      ],
    }));

    expect(useGraphStore.getState().edges).toHaveLength(1);

    const { onNodesChange } = useGraphStore.getState();
    onNodesChange([{ type: 'remove', id: sourceId }]);

    const state = useGraphStore.getState();
    expect(state.nodes).toHaveLength(1);
    expect(state.edges).toHaveLength(0);
  });

  it('removes a node without affecting unrelated edges', () => {
    const { addNode } = useGraphStore.getState();
    addNode('text-input', { x: 0, y: 0 });
    addNode('gpt-image-1-generate', { x: 300, y: 0 });
    addNode('preview', { x: 600, y: 0 });

    const { nodes } = useGraphStore.getState();
    const [textNode, gptNode, previewNode] = nodes;

    useGraphStore.setState((state) => ({
      edges: [
        {
          id: 'edge-1',
          source: textNode.id,
          sourceHandle: 'text',
          target: gptNode.id,
          targetHandle: 'prompt',
          type: 'typed-edge',
          data: { dataType: 'Text' },
        },
        {
          id: 'edge-2',
          source: gptNode.id,
          sourceHandle: 'image',
          target: previewNode.id,
          targetHandle: 'input',
          type: 'typed-edge',
          data: { dataType: 'Image' },
        },
      ],
    }));

    const { onNodesChange } = useGraphStore.getState();
    onNodesChange([{ type: 'remove', id: textNode.id }]);

    const state = useGraphStore.getState();
    expect(state.nodes).toHaveLength(2);
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0].id).toBe('edge-2');
  });
});
