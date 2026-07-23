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
  executeGraphMock.mockResolvedValue({ status: 'started' });
  executeNodeMock.mockClear();
  executeNodeMock.mockResolvedValue({ status: 'started' });
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

describe('executeClusterConcurrent', () => {
  it('posts only the cluster nodes and their internal edges without touching isExecuting', async () => {
    const t = node('t1', 'text-input');
    const m = node('m1', 'nano-banana');
    const unrelated = node('u1', 'flux-schnell');
    const clusterEdge: Edge = {
      id: 'e1', source: 't1', sourceHandle: 'text', target: 'm1', targetHandle: 'prompt', type: 'typed-edge',
    };
    useGraphStore.setState({ nodes: [t, m, unrelated], edges: [clusterEdge], isExecuting: false });

    await useGraphStore.getState().executeClusterConcurrent(['t1', 'm1']);

    expect(executeGraphMock).toHaveBeenCalledTimes(1);
    const [postedNodes, postedEdges] = executeGraphMock.mock.calls[0];
    expect(postedNodes.map((n: { id: string }) => n.id).sort()).toEqual(['m1', 't1']);
    expect(postedEdges.map((e: { id: string }) => e.id)).toEqual(['e1']);
    // isExecuting must stay false — concurrent path never touches the global lock
    expect(useGraphStore.getState().isExecuting).toBe(false);
    // cluster nodes should be queued
    expect(useGraphStore.getState().nodes.find((n) => n.id === 'm1')?.data.state).toBe('queued');
    expect(useGraphStore.getState().nodes.find((n) => n.id === 't1')?.data.state).toBe('queued');
    // unrelated node untouched
    expect(useGraphStore.getState().nodes.find((n) => n.id === 'u1')?.data.state).toBe('idle');
  });

  it('a 2nd call while a 1st is in-flight still posts (not a no-op)', async () => {
    // Simulate first call already running: isExecuting=true (set by canvas path, not us)
    // executeClusterConcurrent must ignore isExecuting entirely
    useGraphStore.setState({ nodes: [node('m1', 'nano-banana'), node('m2', 'nano-banana')], edges: [], isExecuting: true });

    await useGraphStore.getState().executeClusterConcurrent(['m1']);
    await useGraphStore.getState().executeClusterConcurrent(['m2']);

    expect(executeGraphMock).toHaveBeenCalledTimes(2);
    // isExecuting was never touched by the concurrent path
    expect(useGraphStore.getState().isExecuting).toBe(true);
  });

  it('cannot unlock or close an overlapping Canvas run when it completes', async () => {
    useGraphStore.setState({
      nodes: [node('canvas', 'text-input'), node('create', 'nano-banana')],
      edges: [],
      isExecuting: false,
      runHistory: [],
    });

    await useGraphStore.getState().executeGraph();
    const canvasRunId = executeGraphMock.mock.calls[0][2] as string;
    expect(canvasRunId).toEqual(expect.any(String));
    expect(useGraphStore.getState().isExecuting).toBe(true);
    expect(useGraphStore.getState().runHistory[0].status).toBe('running');

    await useGraphStore.getState().executeClusterConcurrent(['create']);
    const createRunId = executeGraphMock.mock.calls[1][2] as string;
    expect(createRunId).toEqual(expect.any(String));
    expect(createRunId).not.toBe(canvasRunId);

    useGraphStore.getState().handleExecutionEvent({
      type: 'graphComplete',
      runId: createRunId,
      duration: 1,
      nodesExecuted: 1,
    });

    expect(useGraphStore.getState().isExecuting).toBe(true);
    expect(useGraphStore.getState().runHistory[0].status).toBe('running');

    useGraphStore.getState().handleExecutionEvent({
      type: 'graphComplete',
      runId: canvasRunId,
      duration: 2,
      nodesExecuted: 2,
    });

    expect(useGraphStore.getState().isExecuting).toBe(false);
    expect(useGraphStore.getState().runHistory[0].status).toBe('complete');
  });

  it('shows the exact backend capability error on the Create model node', async () => {
    const message = 'Gemini Omni capability guardrail: use Veo 3.1 for video extension.';
    executeGraphMock.mockResolvedValueOnce({
      status: 'validation_error',
      errors: [{ nodeId: 'm1', portId: 'prompt', message }],
    });
    const promptNode = node('t1', 'text-input');
    const modelNode = node('m1', 'gemini-omni-flash');
    useGraphStore.setState({
      nodes: [promptNode, modelNode],
      edges: [{
        id: 'e1', source: 't1', sourceHandle: 'text', target: 'm1', targetHandle: 'prompt', type: 'typed-edge',
      }],
    });

    await useGraphStore.getState().executeClusterConcurrent(['t1', 'm1']);

    const updated = useGraphStore.getState().nodes.find((n) => n.id === 'm1');
    expect(updated?.data.state).toBe('error');
    expect(updated?.data.error).toBe(message);
  });
});

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

  it('applies _createOrigin even when graphSync delivered the node first (upsert, no clobber)', async () => {
    // Simulate the WS graphSync having already added the model node (untagged, mid-execution).
    useGraphStore.setState({
      nodes: [{
        id: 'n2', type: 'model-node', position: { x: 0, y: 0 },
        data: { label: 'nano-banana', definitionId: 'nano-banana', params: {}, state: 'executing',
          outputs: { image: { type: 'Image', value: '/api/outputs/partial.png' } } },
      }] as never,
      edges: [],
    });
    const { modelNodeIds } = await useGraphStore.getState().authorGenerationCluster(baseRequest({}));
    const matches = useGraphStore.getState().nodes.filter((n) => n.id === 'n2');
    expect(matches).toHaveLength(1);                          // no duplicate
    expect((matches[0].data._createOrigin as { sessionId: string }).sessionId).toBe('s1'); // tag applied
    expect(matches[0].data.state).toBe('executing');         // existing state preserved
    expect(matches[0].data.outputs.image?.value).toBe('/api/outputs/partial.png'); // outputs preserved
    expect(modelNodeIds).toContain('n2');
  });

  it('gives each variation a distinct cache-busting _variant (no-seed model)', async () => {
    // nano-banana has no seed param, so each model node needs a distinct `_variant`
    // or the backend ExecutionCache returns the same image for every variation.
    const { modelNodeIds } = await useGraphStore.getState().authorGenerationCluster(baseRequest({ quantity: 3 }));
    const variants = useGraphStore.getState().nodes
      .filter((n) => modelNodeIds.includes(n.id))
      .map((n) => n.data.params._variant as string | undefined);
    expect(variants).toHaveLength(3);
    expect(variants.every((x) => typeof x === 'string' && x.length > 0)).toBe(true);
    expect(new Set(variants).size).toBe(3); // all distinct → distinct cache keys
  });
});

describe('deleteGeneration', () => {
  it('removes the given model nodes and their now-orphaned input nodes + touching edges', () => {
    resetStore();
    useGraphStore.setState({
      nodes: [
        node('t1', 'text-input'), node('m1', 'nano-banana'), node('m2', 'nano-banana'),
        node('keep', 'flux-schnell'),
      ],
      edges: [
        { id: 'e1', source: 't1', sourceHandle: 'text', target: 'm1', targetHandle: 'prompt', type: 'typed-edge' },
        { id: 'e2', source: 't1', sourceHandle: 'text', target: 'm2', targetHandle: 'prompt', type: 'typed-edge' },
      ],
    });
    // delete only m1 → t1 still feeds m2, so t1 stays
    useGraphStore.getState().deleteGeneration(['m1']);
    let ids = useGraphStore.getState().nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['keep', 'm2', 't1']);
    // delete m2 → t1 now orphaned → removed too
    useGraphStore.getState().deleteGeneration(['m2']);
    ids = useGraphStore.getState().nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['keep']);
    expect(useGraphStore.getState().edges).toHaveLength(0);
  });
});
