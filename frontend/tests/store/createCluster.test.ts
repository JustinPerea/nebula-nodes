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
  });

  it('is a no-op when already executing', async () => {
    useGraphStore.setState({ nodes: [node('m1', 'nano-banana')], isExecuting: true });
    await useGraphStore.getState().executeCluster(['m1']);
    expect(executeGraphMock).not.toHaveBeenCalled();
  });
});

describe('authorGenerationCluster', () => {
  it('creates a text-input + model node wired prompt->model with merged params and origin tag', () => {
    const { modelNodeIds, allNodeIds } = useGraphStore.getState().authorGenerationCluster(baseRequest({}));
    const { nodes, edges } = useGraphStore.getState();

    expect(allNodeIds).toHaveLength(2);
    expect(modelNodeIds).toHaveLength(1);

    const textNode = nodes.find((n) => n.data.definitionId === 'text-input');
    const modelNode = nodes.find((n) => n.id === modelNodeIds[0]);
    expect(textNode?.data.params.value).toBe('a calico cat');
    // default model param preserved, composer param applied
    expect(modelNode?.data.params.model).toBe('gemini-3.1-flash-image-preview');
    expect(modelNode?.data.params.aspect_ratio).toBe('16:9');
    expect((modelNode?.data._createOrigin as { sessionId: string }).sessionId).toBe('s1');

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: textNode!.id, sourceHandle: 'text', target: modelNode!.id, targetHandle: 'prompt',
    });
  });

  it('omits the text-input when the prompt is empty', () => {
    const { allNodeIds } = useGraphStore.getState().authorGenerationCluster(baseRequest({ prompt: '   ' }));
    const { nodes } = useGraphStore.getState();
    expect(allNodeIds).toHaveLength(1);
    expect(nodes.some((n) => n.data.definitionId === 'text-input')).toBe(false);
  });

  it('creates an image-input wired to the model image port for each ref path', () => {
    useGraphStore.getState().authorGenerationCluster(
      baseRequest({ refPaths: ['/api/outputs/a.png'] }),
    );
    const { nodes, edges } = useGraphStore.getState();
    const imgNode = nodes.find((n) => n.data.definitionId === 'image-input');
    expect(imgNode?.data.params.filePath).toBe('/api/outputs/a.png');
    // nano-banana's image input port id is 'images'
    expect(edges.some((e) => e.source === imgNode!.id && e.targetHandle === 'images')).toBe(true);
  });

  it('fans out quantity>1 into multiple model nodes sharing one text input', () => {
    const { modelNodeIds } = useGraphStore.getState().authorGenerationCluster(
      baseRequest({ quantity: 3 }),
    );
    const { nodes, edges } = useGraphStore.getState();
    expect(modelNodeIds).toHaveLength(3);
    expect(nodes.filter((n) => n.data.definitionId === 'text-input')).toHaveLength(1);
    expect(edges).toHaveLength(3); // one text->model edge per variation
  });
});
