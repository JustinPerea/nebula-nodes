import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { CinemaSceneSpec, NodeData, PortValue } from '../src/types';
import * as api from '../src/lib/api';
import { RUN_HISTORY_STORAGE_KEY, type RunRecord } from '../src/lib/runHistory';
import { useGraphStore } from '../src/store/graphStore';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

const image = (name: string): PortValue => ({ type: 'Image', value: `https://fixture/${name}.png` });
function scene(): CinemaSceneSpec {
  return { version: 1, base: { model: 'nano-banana' }, aspectRatio: '16:9', shots: [
    { id: 'a', prompt: 'Original A', output: { status: 'idle' } },
    { id: 'b', prompt: 'Original B', output: { status: 'idle' } },
  ] };
}
function node(): Node<NodeData> {
  return { id: 'scene', position: { x: 0, y: 0 }, data: {
    definitionId: 'cinema-scene', label: 'Scene', state: 'idle', params: { scene: scene() }, outputs: {},
  } };
}

describe('Cinema delayed execution outputs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useGraphStore.getState().resetExecution();
    localStorage.clear();
    useGraphStore.setState({ nodes: [node()], edges: [], runHistory: [],
      providerRecoveries: [], providerStartAmbiguities: [], isImportingGraph: false,
      backendFreshStartPending: false, undoStack: [], redoStack: [] });
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' });
  });
  afterEach(() => {
    useGraphStore.getState().resetExecution();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps all recipe artifacts in history while merging only current shot ports into the edited scene', async () => {
    const earlier: RunRecord = { id: 'earlier-scene-run', trigger: 'graph', startedAt: 1, status: 'complete',
      snapshot: { nodes: [], edges: [] }, resultOutputs: { scene: { shot_old: image('earlier-result') } } };
    useGraphStore.setState({ runHistory: [earlier] });
    await useGraphStore.getState().executeClusterConcurrent(['scene']);
    const runId = useGraphStore.getState().activeRuns[0].id;
    const edited: CinemaSceneSpec = { ...scene(), character: {
      refImageUrls: ['https://fixture/accepted-after-start.png'], strength: 0.8,
    }, shots: [
      { id: 'c', prompt: 'New completed sibling', output: { status: 'done', imageUrl: 'https://fixture/new-sibling.png' } },
      { id: 'a', prompt: 'Edited A', refImageUrls: ['https://fixture/new-ref.png'] },
      { id: 'd', prompt: 'New idle sibling' },
    ] };
    useGraphStore.getState().updateScene('scene', edited);
    useGraphStore.getState().updateNodeData('scene', { outputs: {
      shot_a: image('previous-a'), shot_c: image('new-sibling'),
    } });
    const recipeOutputs = { shot_a: image('generated-a'), shot_b: image('generated-removed-b') };
    useGraphStore.getState().handleExecutionEvent({ type: 'executed', nodeId: 'scene', runId, outputs: recipeOutputs });
    useGraphStore.getState().handleExecutionEvent({ type: 'graphComplete', runId, duration: 1, nodesExecuted: 1 });

    const live = useGraphStore.getState().nodes[0];
    expect(live.data.outputs).toEqual({ shot_a: image('generated-a'), shot_c: image('new-sibling') });
    expect(live.data.params.scene).toEqual(edited);
    expect(live.data.state).toBe('complete');
    const history = useGraphStore.getState().runHistory[0];
    expect(history.snapshot.nodes[0].params.scene).toEqual(scene());
    expect(history.resultOutputs?.scene).toEqual(recipeOutputs);
    expect(Object.isFrozen(history.resultOutputs?.scene.shot_b)).toBe(true);
    expect(JSON.parse(localStorage.getItem(RUN_HISTORY_STORAGE_KEY) ?? '{}').records[0].resultOutputs.scene).toEqual(recipeOutputs);
    expect(useGraphStore.getState().runHistory[1]).toBe(earlier);
    recipeOutputs.shot_b.value = 'https://fixture/mutated-event.png';
    expect(history.resultOutputs?.scene.shot_b).toEqual(image('generated-removed-b'));
    expect(api.executeGraph).toHaveBeenCalledOnce();
  });

  it('does not restore any live shot output when every recipe shot was removed before completion', async () => {
    await useGraphStore.getState().executeClusterConcurrent(['scene']);
    const runId = useGraphStore.getState().activeRuns[0].id;
    useGraphStore.getState().updateScene('scene', { ...scene(), shots: [] });
    const recipeOutputs = { shot_a: image('generated-a'), shot_b: image('generated-b') };
    useGraphStore.getState().handleExecutionEvent({ type: 'executed', nodeId: 'scene', runId, outputs: recipeOutputs });
    expect(useGraphStore.getState().nodes[0].data.outputs).toEqual({});
    expect(useGraphStore.getState().runHistory[0].resultOutputs?.scene).toEqual(recipeOutputs);
    expect(api.executeGraph).toHaveBeenCalledOnce();
  });
});
