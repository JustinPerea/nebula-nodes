import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { useGraphStore } from '../src/store/graphStore';
import * as api from '../src/lib/api';
import { serializeGraph, deserializeGraph } from '../src/lib/graphFile';
import { getCreateModels } from '../src/lib/createModels';
import { useIsValidConnection } from '../src/hooks/useIsValidConnection';
import { loadRunHistory, persistRunHistory } from '../src/lib/runHistory';

const flow = vi.hoisted(() => ({ nodes: [] as unknown[], edges: [] as unknown[] }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
vi.mock('@xyflow/react', async (original) => ({
  ...await original<typeof import('@xyflow/react')>(),
  useReactFlow: () => ({ getNodes: () => flow.nodes, getEdges: () => flow.edges }),
}));
function model(id: string): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 }, data: {
    definitionId: 'nano-banana', label: id, params: {}, outputs: {}, state: 'idle',
  } };
}
beforeEach(() => {
  vi.useFakeTimers();
  useGraphStore.getState().resetExecution();
  localStorage.clear();
  useGraphStore.setState({ nodes: [model('model')], edges: [], runHistory: [], isExecuting: false, isCancelling: false, providerStartAmbiguities: [] });
  vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' });
  vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' });
  vi.spyOn(api, 'cancelExecution').mockResolvedValue({ status: 'cancelled', runId: '' });
  vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ status: 'running', runId: '' });
});
afterEach(() => { useGraphStore.getState().resetExecution(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('audit: intended functional contracts', () => {
  it('Create generation gets history and Stop cancels accepted job', async () => {
    await useGraphStore.getState().executeClusterConcurrent(['model']);
    const runId = vi.mocked(api.executeGraph).mock.calls[0][2]!;
    const historyBeforeStop = useGraphStore.getState().runHistory;
    await useGraphStore.getState().cancelExecution();
    expect({ historyIds: historyBeforeStop.map((run) => run.id), cancelIds: vi.mocked(api.cancelExecution).mock.calls.map((args) => args[0]) })
      .toEqual({ historyIds: [runId], cancelIds: [runId] });
  });
  it('returning to Canvas cannot start another job on a model already running in Create', async () => {
    await useGraphStore.getState().executeClusterConcurrent(['model']);
    await useGraphStore.getState().executeNode('model');
    expect(vi.mocked(api.executeGraph).mock.calls.length + vi.mocked(api.executeNode).mock.calls.length).toBe(1);
  });
  it('result from a still-running older Create job cannot replace a newer Canvas generation', async () => {
    await useGraphStore.getState().executeClusterConcurrent(['model']);
    const oldRun = vi.mocked(api.executeGraph).mock.calls[0][2]!;
    // User returns to Canvas, edits ratio, and clicks Run before Create finishes.
    useGraphStore.getState().updateNodeData('model', { params: { aspect_ratio: '9:16' } });
    await useGraphStore.getState().executeNode('model');
    const newerCall = vi.mocked(api.executeNode).mock.calls[0];
    if (!newerCall) {
      // A correct overlapping-run guard prevents the competing generation.
      expect(useGraphStore.getState().isExecuting).toBe(true);
      expect(useGraphStore.getState().runHistory).toHaveLength(1);
      return;
    }
    expect(newerCall[3]).not.toBe(oldRun);
    expect(useGraphStore.getState().nodes[0].data.state).toBe('queued');
    // Normal valid ordering: old job's result arrives while the newer job waits.
    // Neither job has emitted graphComplete yet.
    useGraphStore.getState().handleExecutionEvent({ type: 'executed', runId: oldRun, nodeId: 'model', outputs: { image: { type: 'Image', value: '/api/outputs/old.png' } } });
    expect({ state: useGraphStore.getState().nodes[0].data.state, outputs: useGraphStore.getState().nodes[0].data.outputs }).toEqual({ state: 'queued', outputs: {} });
  });
  it('browser reload retains active non-World run ownership until backend reconciliation', async () => {
    await useGraphStore.getState().executeNode('model');
    const history = useGraphStore.getState().runHistory;
    persistRunHistory(history);
    expect(loadRunHistory()[0].status).toBe('running');
  });
  it('saved Cinema shot output remains connectable after file round trip', () => {
    const shotPort = { id: 'shot_a', label: 'Shot 1', dataType: 'Image', required: false };
    const scene = { ...model('scene'), type: 'cinemaSceneNode', data: {
      ...model('scene').data, definitionId: 'cinema-scene', isDynamic: true,
      dynamicOutputPorts: [shotPort], dynamicInputPorts: [], params: { scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [{ id: 'a', prompt: 'a scene' }] } },
    } } as unknown as Node<NodeData>;
    const target = { ...model('video'), data: { ...model('video').data, definitionId: 'veo-3' } };
    const connection = { source: 'scene', sourceHandle: 'shot_a', target: 'video', targetHandle: 'image' };
    flow.nodes = [scene, target]; flow.edges = [];
    const hook = renderHook(() => useIsValidConnection());
    expect(hook.result.current(connection)).toBe(true);
    const loaded = deserializeGraph(serializeGraph([scene, target], []));
    useGraphStore.getState().loadGraph(loaded.nodes, loaded.edges);
    flow.nodes = useGraphStore.getState().nodes;
    expect(hook.result.current(connection)).toBe(true);
  });
  it('Create filters Runway Aleph until it can supply the required Video input', () => {
    expect(getCreateModels().some((model) => model.id === 'runway-aleph')).toBe(false);
  });

});
