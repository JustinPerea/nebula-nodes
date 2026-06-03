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
