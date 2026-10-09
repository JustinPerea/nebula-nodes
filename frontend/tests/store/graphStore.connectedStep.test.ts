import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import type { ExecutionEvent } from '../../src/lib/wsClient';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), sync: null as ((event: ExecutionEvent) => void) | null }));
vi.mock('../../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/backend')>(),
  apiFetch: transport.fetch,
}));
vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn((callback) => { transport.sync = callback; }), disconnect: vi.fn() },
}));

import { useGraphStore } from '../../src/store/graphStore';

const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
const position = { x: 420, y: 100 };
const connect = { source: 'n1', sourceHandle: 'image', target: '', targetHandle: 'image', newNodeIs: 'target' as const };
const canonicalEdge: Edge = { id: 'e2', source: 'n1', sourceHandle: 'image', target: 'n3', targetHandle: 'image',
  type: 'typed-edge', data: { dataType: 'Image' } };
const priorEdge: Edge = { id: 'e1', source: 'n1', sourceHandle: 'image', target: 'n2', targetHandle: 'value',
  type: 'typed-edge', data: { dataType: 'Image' } };

function node(id: string, definitionId = 'nano-banana'): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 100 },
    data: { label: id, definitionId, params: {}, state: 'idle', outputs: {} } };
}

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function confirmed(edge: Edge = canonicalEdge) {
  return response({ id: 'n3', definitionId: 'veo-3', params: { duration: '8' }, position,
    connected: true, edge });
}

function deferred() {
  let resolve!: (value: ReturnType<typeof response>) => void;
  const promise = new Promise<ReturnType<typeof response>>((done) => { resolve = done; });
  transport.fetch.mockReturnValueOnce(promise);
  return resolve;
}

function graphSync(nodes: Node<NodeData>[], edges: Edge[], graphReplaced = false) {
  transport.sync?.({ type: 'graphSync', nodes, edges, empty: nodes.length === 0, graphReplaced });
}

function dispatchedNode(id = 'n3'): Node<NodeData> {
  const request = transport.fetch.mock.calls.find(([url]) => url === '/api/graph/node-and-connect')!;
  const body = JSON.parse(request[1].body);
  return { ...node(id, body.definitionId), position: body.position,
    data: { ...node(id, body.definitionId).data, params: body.params } };
}

function nextConfirmed() {
  return response({ id: 'n4', definitionId: 'veo-3', connected: true,
    edge: { ...canonicalEdge, id: 'e3', target: 'n4' } });
}

beforeEach(() => {
  transport.fetch.mockReset();
  alert.mockClear();
  useGraphStore.getState().resetExecution();
  useGraphStore.getState().loadGraph([], []);
  const source = node('n1');
  source.data.outputs = { image: { type: 'Image', value: '/outputs/original-logo.png' } };
  source.data.state = 'complete';
  useGraphStore.setState({ nodes: [source, node('n2', 'preview')], edges: [priorEdge],
    undoStack: [], redoStack: [], runHistory: [{ id: 'prior-run', trigger: 'node', startedAt: 1,
      status: 'complete', targetNodeId: 'n1', snapshot: { nodes: [{ id: 'n1', definitionId: 'nano-banana',
        params: { seed: 12 }, outputs: {} }], edges: [] }, resultOutputs: { n1: source.data.outputs } }],
    isExecuting: false, isImportingGraph: false,
    providerRecoveries: [], providerStartAmbiguities: [], backendFreshStartPending: false });
});

describe('connected next-step preparation', () => {
  it('exposes a confirmed idle node and canonical wire before resolving, with one undo step', async () => {
    const before = useGraphStore.getState();
    transport.fetch.mockResolvedValueOnce(confirmed());

    const id = await before.addNodeAndConnect('veo-3', position, connect);
    const state = useGraphStore.getState();
    expect(id).toBe('n3');
    expect(state.nodes.map((item) => item.id)).toEqual(['n1', 'n2', 'n3']);
    expect(state.nodes[2]).toMatchObject({ id: 'n3', position, data: { definitionId: 'veo-3', params: { duration: '8' }, state: 'idle', outputs: {} } });
    expect(state.nodes[0]).toBe(before.nodes[0]);
    expect(state.edges).toEqual([priorEdge, canonicalEdge]);
    expect(state.runHistory).toBe(before.runHistory);
    expect(state.undoStack).toHaveLength(1);
    expect(state.undoStack[0].nodes.map((item) => item.id)).toEqual(['n1', 'n2']);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(transport.fetch).toHaveBeenCalledWith('/api/graph/node-and-connect', expect.objectContaining({ method: 'POST' }));
    expect(transport.fetch.mock.calls.some(([path]) => String(path).includes('execute') || String(path).includes('generate'))).toBe(false);

    state.undo();
    expect(useGraphStore.getState().nodes.map((item) => item.id)).toEqual(['n1', 'n2']);
    expect(useGraphStore.getState().nodes[0].data.outputs).toEqual(before.nodes[0].data.outputs);
    expect(useGraphStore.getState().edges).toEqual([priorEdge]);
  });

  it('uses the pre-request undo snapshot when graphSync arrives before acknowledgement', async () => {
    const resolve = deferred();
    const pending = useGraphStore.getState().addNodeAndConnect('veo-3', position, connect);
    const source = node('n1');
    source.data.outputs = { image: { type: 'Image', value: '/outputs/original-logo.png' } };
    source.data.state = 'complete';
    const canonicalNode = node('n3', 'veo-3');
    canonicalNode.data.params = { duration: '8', seed: 42 };
    graphSync([source, node('n2', 'preview'), canonicalNode], [priorEdge, canonicalEdge]);
    const synced = useGraphStore.getState().nodes.find((item) => item.id === 'n3');
    resolve(confirmed());

    expect(await pending).toBe('n3');
    const state = useGraphStore.getState();
    expect(state.nodes.filter((item) => item.id === 'n3')).toHaveLength(1);
    expect(state.nodes.find((item) => item.id === 'n3')).toBe(synced);
    expect(state.nodes.find((item) => item.id === 'n3')?.data.params.seed).toBe(42);
    expect(state.edges.filter((item) => item.target === 'n3')).toEqual([canonicalEdge]);
    expect(state.undoStack).toHaveLength(1);
    state.undo();
    expect(useGraphStore.getState().nodes.map((item) => item.id)).toEqual(['n1', 'n2']);
    expect(useGraphStore.getState().edges).toEqual([priorEdge]);
  });

  it('deduplicates a later graphSync pair and preserves source output and prior run history', async () => {
    const history = useGraphStore.getState().runHistory;
    transport.fetch.mockResolvedValueOnce(confirmed());
    await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect);
    const source = node('n1');
    // Empty stale output metadata must not erase the live source result.
    graphSync([source, node('n2', 'preview'), node('n3', 'veo-3')], [priorEdge, canonicalEdge]);
    expect(useGraphStore.getState().nodes).toHaveLength(3);
    expect(useGraphStore.getState().edges).toEqual([priorEdge, canonicalEdge]);
    expect(useGraphStore.getState().nodes[0].data.outputs.image.value).toBe('/outputs/original-logo.png');
    expect(useGraphStore.getState().runHistory).toBe(history);
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
  });

  it('supports preparing an upstream node from an existing input handle', async () => {
    const edge: Edge = { id: 'e2', source: 'n3', sourceHandle: 'text', target: 'n1', targetHandle: 'prompt', type: 'typed-edge' };
    transport.fetch.mockResolvedValueOnce(response({ id: 'n3', definitionId: 'text-input', connected: true, edge }));
    expect(await useGraphStore.getState().addNodeAndConnect('text-input', position,
      { source: '', sourceHandle: 'text', target: 'n1', targetHandle: 'prompt', newNodeIs: 'source' })).toBe('n3');
    expect(useGraphStore.getState().edges).toEqual([priorEdge, edge]);
  });

  it('surfaces the backend rejection detail without adding a pair or undo snapshot', async () => {
    transport.fetch.mockResolvedValueOnce(response({ detail: 'Selected image input already has a connection.' }, false, 400));
    const before = useGraphStore.getState();
    expect(await before.addNodeAndConnect('veo-3', position, connect)).toBeNull();
    expect(useGraphStore.getState().nodes).toBe(before.nodes);
    expect(useGraphStore.getState().edges).toBe(before.edges);
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('Selected image input already has a connection.'));
  });

  it.each([
    ['unknown definition', () => {}, 'removed-model', connect],
    ['missing origin', () => {}, 'veo-3', { ...connect, source: 'n99' }],
    ['local-only origin', () => useGraphStore.setState({ nodes: [node('local-source')] }), 'veo-3', { ...connect, source: 'local-source' }],
    ['missing port', () => {}, 'veo-3', { ...connect, sourceHandle: 'removed-port' }],
    ['wrong data type', () => {}, 'veo-3', { ...connect, targetHandle: 'prompt' }],
    ['active execution', () => useGraphStore.setState({ isExecuting: true }), 'veo-3', connect],
    ['active import', () => useGraphStore.setState({ isImportingGraph: true }), 'veo-3', connect],
  ])('guards %s before sending a request', async (_label, setup, definitionId, connection) => {
    setup();
    expect(await useGraphStore.getState().addNodeAndConnect(definitionId, position, connection)).toBeNull();
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalled();
  });

  it.each(['import', 'authoritative replacement'])('does not adopt a late pair after %s with reused source IDs', async (kind) => {
    const resolve = deferred();
    const pending = useGraphStore.getState().addNodeAndConnect('veo-3', position, connect);
    if (kind === 'import') useGraphStore.getState().loadGraph([node('n1')], []);
    else graphSync([node('n1')], [], true);
    resolve(confirmed());
    expect(await pending).toBeNull();
    expect(useGraphStore.getState().nodes.map((item) => item.id)).toEqual(['n1']);
    expect(useGraphStore.getState().edges).toEqual([]);
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('canvas changed'));
  });

  it('permanently revokes a request when its source is deleted and restored before acknowledgement', async () => {
    const resolve = deferred();
    const pending = useGraphStore.getState().addNodeAndConnect('veo-3', position, connect);
    useGraphStore.setState({ nodes: [node('n2', 'preview')], edges: [] });
    useGraphStore.setState({ nodes: [node('n1'), node('n2', 'preview')] });
    resolve(confirmed());
    expect(await pending).toBeNull();
    expect(useGraphStore.getState().nodes).toHaveLength(2);
    expect(useGraphStore.getState().edges).toEqual([]);
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
  });

  it('blocks a second click while the backend request is pending', async () => {
    const resolve = deferred();
    const pending = useGraphStore.getState().addNodeAndConnect('veo-3', position, connect);
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect)).toBeNull();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    resolve(confirmed());
    expect(await pending).toBe('n3');
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
  });

  it.each([
    { id: 'n3', definitionId: 'veo-3' },
    { id: 'n3', connected: false, edge: canonicalEdge },
    { id: 'n3', connected: true, edge: { ...canonicalEdge, targetHandle: 'prompt' } },
    { id: 'n1', connected: true, edge: canonicalEdge },
    { id: 'n3', definitionId: 'text-input', connected: true, edge: canonicalEdge },
  ])('requires a valid confirmation of the requested pair: %j', async (body) => {
    transport.fetch.mockResolvedValueOnce(response(body));
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect)).toBeNull();
    expect(useGraphStore.getState().nodes).toHaveLength(2);
    expect(useGraphStore.getState().edges).toEqual([priorEdge]);
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
    expect(alert).toHaveBeenCalled();
  });

  it('does not retry or create a local copy when the response is lost', async () => {
    transport.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect)).toBeNull();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(useGraphStore.getState().nodes).toHaveLength(2);
    expect(useGraphStore.getState().edges).toEqual([priorEdge]);
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('may have committed'));
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect)).toBeNull();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenLastCalledWith(expect.stringContaining('still unresolved'));
  });

  it.each(['missing pair', 'invalid JSON', 'HTTP 500'])('quarantines an uncertain %s response', async (kind) => {
    transport.fetch.mockResolvedValueOnce(kind === 'invalid JSON'
      ? { ok: true, json: async () => { throw new SyntaxError('Truncated fixture'); } }
      : kind === 'HTTP 500' ? response({ detail: 'Synthetic failure after commit' }, false, 500)
        : response({ id: 'n3', definitionId: 'veo-3' }));
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect)).toBeNull();
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect)).toBeNull();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  });

  it('allows retry after a definite atomic HTTP 400 rejection', async () => {
    transport.fetch.mockResolvedValueOnce(response({ detail: 'Invalid port' }, false, 400));
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect)).toBeNull();
    transport.fetch.mockResolvedValueOnce(confirmed());
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect)).toBe('n3');
    expect(transport.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['standalone', 'wrong handles', 'wrong position', 'wrong params', 'untyped edge'])(
    'keeps uncertainty quarantined after a %s graphSync', async (kind) => {
      transport.fetch.mockRejectedValueOnce(new TypeError('Lost acknowledgement'));
      await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect);
      const created = dispatchedNode();
      if (kind === 'wrong position') created.position = { ...position, x: position.x + 20 };
      if (kind === 'wrong params') created.data.params = {};
      const edge = kind === 'wrong handles' ? { ...canonicalEdge, targetHandle: 'prompt' }
        : kind === 'untyped edge' ? { ...canonicalEdge, type: undefined } : canonicalEdge;
      graphSync([node('n1'), node('n2', 'preview'), created], kind === 'standalone' ? [priorEdge] : [priorEdge, edge]);
      expect(await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect)).toBeNull();
      expect(transport.fetch).toHaveBeenCalledTimes(1);
    });

  it('releases uncertainty only after the exact new canonical node and wire sync', async () => {
    transport.fetch.mockRejectedValueOnce(new TypeError('Lost acknowledgement'));
    await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect);
    graphSync([node('n1'), node('n2', 'preview'), dispatchedNode()], [priorEdge, canonicalEdge]);
    transport.fetch.mockResolvedValueOnce(nextConfirmed());
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect)).toBe('n4');
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    expect(useGraphStore.getState().edges).toEqual([priorEdge, canonicalEdge, { ...canonicalEdge, id: 'e3', target: 'n4' }]);
  });

  it('uses a canonical graphSync seen before the malformed HTTP acknowledgement to settle uncertainty', async () => {
    const resolve = deferred();
    const pending = useGraphStore.getState().addNodeAndConnect('veo-3', position, connect);
    graphSync([node('n1'), node('n2', 'preview'), dispatchedNode()], [priorEdge, canonicalEdge]);
    resolve(response({ id: 'n3' }));
    expect(await pending).toBeNull();
    transport.fetch.mockResolvedValueOnce(nextConfirmed());
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect)).toBe('n4');
    expect(transport.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['load', 'authoritative replacement'])('releases uncertainty after %s', async (kind) => {
    transport.fetch.mockRejectedValueOnce(new TypeError('Lost acknowledgement'));
    await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect);
    const nodes = [node('n1'), node('n2', 'preview')];
    if (kind === 'load') useGraphStore.getState().loadGraph(nodes, [priorEdge]);
    else graphSync(nodes, [priorEdge], true);
    transport.fetch.mockResolvedValueOnce(confirmed());
    expect(await useGraphStore.getState().addNodeAndConnect('veo-3', position, connect)).toBe('n3');
    expect(transport.fetch).toHaveBeenCalledTimes(2);
  });
});
