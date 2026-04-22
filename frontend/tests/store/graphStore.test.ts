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

function resetStore() {
  useGraphStore.setState({
    nodes: [],
    edges: [],
    undoStack: [],
    redoStack: [],
    clipboard: null,
    isExecuting: false,
  });
}

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

// ---------------------------------------------------------------------------
// Undo/Redo tests
// ---------------------------------------------------------------------------

describe('undo/redo', () => {
  beforeEach(resetStore);

  it('undo restores previous state after addNode', () => {
    useGraphStore.getState().addNode('text-input', { x: 100, y: 100 });
    expect(useGraphStore.getState().nodes).toHaveLength(1);

    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('redo restores the undone state', () => {
    useGraphStore.getState().addNode('text-input', { x: 100, y: 100 });
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toHaveLength(0);

    useGraphStore.getState().redo();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });

  it('undo preserves node outputs', () => {
    useGraphStore.getState().addNode('text-input', { x: 100, y: 100 });
    const nodeId = useGraphStore.getState().nodes[0].id;

    // Simulate execution producing an output (not a param change, won't push undo)
    useGraphStore.setState((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, state: 'complete', outputs: { text: { type: 'Text', value: 'hello world' } } } }
          : n
      ),
    }));

    // Change a param (this pushes undo)
    useGraphStore.getState().updateNodeData(nodeId, { params: { value: 'new text' } });

    // Undo should restore the old params but keep the output
    useGraphStore.getState().undo();
    const node = useGraphStore.getState().nodes.find((n) => n.id === nodeId);
    expect(node?.data.outputs).toMatchObject({ text: { type: 'Text', value: 'hello world' } });
  });

  it('new mutation clears redo stack', () => {
    useGraphStore.getState().addNode('text-input', { x: 100, y: 100 });
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().redoStack).toHaveLength(1);

    useGraphStore.getState().addNode('text-input', { x: 200, y: 200 });
    expect(useGraphStore.getState().redoStack).toHaveLength(0);
  });

  it('caps undo stack at 50 entries', () => {
    for (let i = 0; i < 60; i++) {
      useGraphStore.getState().addNode('text-input', { x: i * 10, y: 0 });
    }
    expect(useGraphStore.getState().undoStack.length).toBeLessThanOrEqual(50);
  });

  it('undo does nothing when stack is empty', () => {
    useGraphStore.getState().addNode('text-input', { x: 0, y: 0 });
    useGraphStore.setState({ undoStack: [] });
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });

  it('redo does nothing when stack is empty', () => {
    useGraphStore.getState().addNode('text-input', { x: 0, y: 0 });
    expect(useGraphStore.getState().redoStack).toHaveLength(0);
    useGraphStore.getState().redo();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });

  it('loadGraph clears both stacks', () => {
    useGraphStore.getState().addNode('text-input', { x: 0, y: 0 });
    expect(useGraphStore.getState().undoStack.length).toBeGreaterThan(0);

    useGraphStore.getState().loadGraph([], []);
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
    expect(useGraphStore.getState().redoStack).toHaveLength(0);
  });

  it('clearGraph is undoable', () => {
    useGraphStore.getState().addNode('text-input', { x: 0, y: 0 });
    // Reset undo stack so only the clearGraph push is tracked
    useGraphStore.setState({ undoStack: [] });

    useGraphStore.getState().clearGraph();
    expect(useGraphStore.getState().nodes).toHaveLength(0);

    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Copy/paste tests
// ---------------------------------------------------------------------------

describe('copy/paste', () => {
  beforeEach(resetStore);

  it('paste creates nodes with new IDs', () => {
    useGraphStore.getState().addNode('text-input', { x: 100, y: 100 });
    const originalId = useGraphStore.getState().nodes[0].id;

    // Select and copy
    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });
    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();

    const nodes = useGraphStore.getState().nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes[1].id).not.toBe(originalId);
  });

  it('paste offsets position by 20px', () => {
    useGraphStore.getState().addNode('text-input', { x: 100, y: 200 });
    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });
    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();

    const pasted = useGraphStore.getState().nodes[1];
    expect(pasted.position.x).toBe(120);
    expect(pasted.position.y).toBe(220);
  });

  it('paste clears outputs and resets state to idle', () => {
    useGraphStore.getState().addNode('text-input', { x: 100, y: 100 });
    const nodeId = useGraphStore.getState().nodes[0].id;

    // Manually set outputs on the node
    useGraphStore.setState((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, state: 'complete', outputs: { text: { type: 'Text', value: 'hello' } } } }
          : n
      ),
    }));

    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });
    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();

    const pasted = useGraphStore.getState().nodes[1];
    expect(pasted.data.state).toBe('idle');
    expect(Object.keys(pasted.data.outputs)).toHaveLength(0);
  });

  it('paste remaps internal edges to new IDs', () => {
    useGraphStore.getState().addNode('text-input', { x: 100, y: 100 });
    useGraphStore.getState().addNode('claude-chat', { x: 300, y: 100 });
    const nodes = useGraphStore.getState().nodes;

    // Manually create an edge between them
    const edge = {
      id: 'test-edge',
      source: nodes[0].id,
      sourceHandle: 'text',
      target: nodes[1].id,
      targetHandle: 'messages',
      type: 'typed-edge',
    };
    useGraphStore.setState({ edges: [edge] });

    // Select all
    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });

    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();

    const allEdges = useGraphStore.getState().edges;
    expect(allEdges).toHaveLength(2);

    const pastedEdge = allEdges[1];
    expect(pastedEdge.id).not.toBe('test-edge');
    expect(pastedEdge.source).not.toBe(nodes[0].id);
    expect(pastedEdge.target).not.toBe(nodes[1].id);
  });

  it('copySelected with no selection does not set clipboard', () => {
    useGraphStore.getState().addNode('text-input', { x: 100, y: 100 });
    // Nodes are not selected
    useGraphStore.getState().copySelected();
    expect(useGraphStore.getState().clipboard).toBeNull();
  });

  it('pasteClipboard with empty clipboard does nothing', () => {
    useGraphStore.setState({ clipboard: null });
    useGraphStore.getState().pasteClipboard();
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// selectAll and duplicateSelected tests
// ---------------------------------------------------------------------------

describe('selectAll', () => {
  beforeEach(resetStore);

  it('selects all nodes', () => {
    useGraphStore.getState().addNode('text-input', { x: 0, y: 0 });
    useGraphStore.getState().addNode('text-input', { x: 100, y: 0 });

    useGraphStore.getState().selectAll();

    const { nodes } = useGraphStore.getState();
    expect(nodes.every((n) => n.selected)).toBe(true);
  });
});

describe('duplicateSelected', () => {
  beforeEach(resetStore);

  it('duplicates selected nodes with new IDs and 20px offset', () => {
    useGraphStore.getState().addNode('text-input', { x: 50, y: 50 });
    const originalId = useGraphStore.getState().nodes[0].id;

    useGraphStore.setState({
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });
    useGraphStore.getState().duplicateSelected();

    const { nodes } = useGraphStore.getState();
    expect(nodes).toHaveLength(2);
    expect(nodes[1].id).not.toBe(originalId);
    expect(nodes[1].position).toEqual({ x: 70, y: 70 });
  });

  it('duplicates selected along with internal edges', () => {
    useGraphStore.getState().addNode('text-input', { x: 0, y: 0 });
    useGraphStore.getState().addNode('claude-chat', { x: 200, y: 0 });
    const [n1, n2] = useGraphStore.getState().nodes;

    useGraphStore.setState({
      edges: [{ id: 'e1', source: n1.id, sourceHandle: 'text', target: n2.id, targetHandle: 'messages', type: 'typed-edge' }],
      nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, selected: true })),
    });

    useGraphStore.getState().duplicateSelected();

    const { edges } = useGraphStore.getState();
    expect(edges).toHaveLength(2);
    expect(edges[1].id).not.toBe('e1');
  });

  it('does nothing when nothing is selected', () => {
    useGraphStore.getState().addNode('text-input', { x: 0, y: 0 });
    const beforeCount = useGraphStore.getState().nodes.length;
    useGraphStore.getState().duplicateSelected();
    expect(useGraphStore.getState().nodes).toHaveLength(beforeCount);
  });
});

describe('graphStore streamPartialImage', () => {
  beforeEach(() => {
    useGraphStore.setState({
      nodes: [
        {
          id: 'n1',
          type: 'default',
          position: { x: 0, y: 0 },
          data: { definitionId: 'gpt-image-2-generate', params: {}, state: 'executing' },
        } as any,
      ],
      edges: [],
    });
  });

  it('appends partials in index order', () => {
    const store = useGraphStore.getState();
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a.png', isFinal: false });
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 1, src: '/b.png', isFinal: false });
    const node = useGraphStore.getState().nodes.find((n) => n.id === 'n1')!;
    expect(node.data.streamingPartials).toEqual([
      { index: 0, src: '/a.png' },
      { index: 1, src: '/b.png' },
    ]);
  });

  it('replaces partial at same index instead of appending duplicate', () => {
    const store = useGraphStore.getState();
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a.png', isFinal: false });
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a2.png', isFinal: false });
    const node = useGraphStore.getState().nodes.find((n) => n.id === 'n1')!;
    expect(node.data.streamingPartials).toEqual([{ index: 0, src: '/a2.png' }]);
  });

  it('clears partials on executed event', () => {
    const store = useGraphStore.getState();
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a.png', isFinal: false });
    store.handleExecutionEvent({ type: 'executed', nodeId: 'n1', outputs: { image: { type: 'Image', value: '/final.png' } } });
    const node = useGraphStore.getState().nodes.find((n) => n.id === 'n1')!;
    expect(node.data.streamingPartials).toBeUndefined();
  });

  it('sorts out-of-order partials by index', () => {
    const store = useGraphStore.getState();
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 2, src: '/c.png', isFinal: false });
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a.png', isFinal: false });
    const node = useGraphStore.getState().nodes.find((n) => n.id === 'n1')!;
    expect(node.data.streamingPartials?.map(p => p.index)).toEqual([0, 2]);
  });

  it('clears partials on error event', () => {
    const store = useGraphStore.getState();
    store.handleExecutionEvent({ type: 'streamPartialImage', nodeId: 'n1', partialIndex: 0, src: '/a.png', isFinal: false });
    store.handleExecutionEvent({ type: 'error', nodeId: 'n1', error: 'test error' });
    const node = useGraphStore.getState().nodes.find((n) => n.id === 'n1')!;
    expect(node.data.streamingPartials).toBeUndefined();
  });
});
