import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import type { NodeData } from '../../src/types';

vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));

const executeGraphMock = vi.fn().mockResolvedValue({ status: 'started' });
const executeNodeMock = vi.fn().mockResolvedValue({ status: 'started' });
vi.mock('../../src/lib/api', () => ({
  executeGraph: (...args: unknown[]) => executeGraphMock(...args),
  executeNode: (...args: unknown[]) => executeNodeMock(...args),
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

import { useGraphStore } from '../../src/store/graphStore';

function node(id: string, definitionId: string): Node<NodeData> {
  return {
    id,
    type: 'model-node',
    position: { x: 0, y: 0 },
    data: { label: id, definitionId, params: {}, state: 'idle', outputs: {} },
  };
}

function resetStore() {
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], isExecuting: false });
}

beforeEach(() => {
  executeGraphMock.mockClear();
  fetchMock.mockReset();
  resetStore();
});

import type { GenerationRequest } from '../../src/types';

function baseRequest(overrides: Partial<GenerationRequest>): GenerationRequest {
  return {
    definitionId: 'nano-banana',
    prompt: 'a calico cat',
    params: { aspect_ratio: '16:9' },
    refPaths: [],
    quantity: 1,
    sessionId: 's1',
    genId: 'g1',
    layoutOrigin: { x: 0, y: 0 },
    ...overrides,
  };
}

describe('executeCluster', () => {
  it('posts only the cluster nodes and their internal edges', async () => {
    const t = node('t1', 'text-input');
    const m = node('m1', 'nano-banana');
    const unrelated = node('u1', 'flux-schnell');
    const clusterEdge: Edge = {
      id: 'e1', source: 't1', sourceHandle: 'text', target: 'm1', targetHandle: 'prompt', type: 'typed-edge',
    };
    useGraphStore.setState({ nodes: [t, m, unrelated], edges: [clusterEdge] });

    await useGraphStore.getState().executeCluster(['t1', 'm1']);

    expect(executeGraphMock).toHaveBeenCalledTimes(1);
    const [postedNodes, postedEdges] = executeGraphMock.mock.calls[0];
    expect(postedNodes.map((n: { id: string }) => n.id).sort()).toEqual(['m1', 't1']);
    expect(postedEdges.map((e: { id: string }) => e.id)).toEqual(['e1']);
    expect(useGraphStore.getState().isExecuting).toBe(true);
    expect(useGraphStore.getState().nodes.find((n) => n.id === 'm1')?.data.state).toBe('queued');
    expect(useGraphStore.getState().nodes.find((n) => n.id === 't1')?.data.state).toBe('queued');
  });

  it('is a no-op when already executing', async () => {
    useGraphStore.setState({ nodes: [node('m1', 'nano-banana')], isExecuting: true });
    await useGraphStore.getState().executeCluster(['m1']);
    expect(executeGraphMock).not.toHaveBeenCalled();
  });
});

// The cluster route returns RF nodes for the new ids. Mock it to echo a deterministic mapping.
function mockClusterResponse(body: { nodes: { tempId: string; definitionId: string; params: Record<string, unknown> }[]; edges: { source: string; target: string; sourceHandle: string; targetHandle: string }[] }) {
  const idMap: Record<string, string> = {};
  const nodes = body.nodes.map((n, i) => {
    const id = `n${i + 1}`;
    idMap[n.tempId] = id;
    return { id, type: 'model-node', position: { x: i * 100, y: 0 },
      data: { label: n.definitionId, definitionId: n.definitionId, params: n.params, state: 'idle', outputs: {} } };
  });
  const edges = body.edges.map((e, i) => ({ id: `e${i + 1}`, source: idMap[e.source], target: idMap[e.target],
    sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, type: 'typed-edge', data: { dataType: 'Text' } }));
  return { idMap, nodes, edges };
}

describe('authorGenerationCluster (backend-first)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_url: string, init?: { body?: string }) => ({
      ok: true, status: 200,
      json: async () => mockClusterResponse(JSON.parse(init!.body as string)),
    }));
  });

  it('POSTs text-input + model to /api/graph/cluster and applies returned nodes with _createOrigin', async () => {
    const { modelNodeIds, allNodeIds } = await useGraphStore.getState().authorGenerationCluster(baseRequest({}));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/graph/cluster'), expect.anything());
    const { nodes, edges } = useGraphStore.getState();
    expect(allNodeIds).toHaveLength(2);
    expect(modelNodeIds).toHaveLength(1);
    const modelNode = nodes.find((n) => n.id === modelNodeIds[0]);
    expect(modelNode?.data.definitionId).toBe('nano-banana');
    expect(modelNode?.data.params.aspect_ratio).toBe('16:9');
    expect((modelNode?.data._createOrigin as { sessionId: string }).sessionId).toBe('s1');
    const textNode = nodes.find((n) => n.data.definitionId === 'text-input');
    expect(textNode?.data._createOrigin).toBeUndefined(); // only model nodes tagged
    expect(edges).toHaveLength(1);
  });

  it('omits text-input when prompt is empty', async () => {
    const { allNodeIds } = await useGraphStore.getState().authorGenerationCluster(baseRequest({ prompt: '  ' }));
    expect(allNodeIds).toHaveLength(1);
    expect(useGraphStore.getState().nodes.some((n) => n.data.definitionId === 'text-input')).toBe(false);
  });

  it('adds an image-input per refPath and quantity>1 model nodes sharing one text-input', async () => {
    const { modelNodeIds } = await useGraphStore.getState().authorGenerationCluster(
      baseRequest({ refPaths: ['/abs/a.png'], quantity: 3 }),
    );
    const { nodes } = useGraphStore.getState();
    expect(modelNodeIds).toHaveLength(3);
    expect(nodes.filter((n) => n.data.definitionId === 'text-input')).toHaveLength(1);
    expect(nodes.filter((n) => n.data.definitionId === 'image-input')).toHaveLength(1);
  });
});
