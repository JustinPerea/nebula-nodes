import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { useGraphStore } from '../src/store/graphStore';
import * as api from '../src/lib/api';
import { getBackendBaseUrl } from '../src/lib/backend';
import { wsClient } from '../src/lib/wsClient';
import { EXECUTION_RECONNECTING_NOTE, WORLD_LABS_RECONNECTING_NOTE, type RunRecord } from '../src/lib/runHistory';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

function model(id: string): Node<NodeData> {
  return { id, position: { x: 0, y: 0 }, data: { label: id, definitionId: 'nano-banana', params: {}, outputs: {}, state: 'idle' } };
}
function cinema(): Node<NodeData> {
  return { ...model('scene'), data: { ...model('scene').data, definitionId: 'cinema-scene', params: { scene: { shots: [{ id: 'a' }, { id: 'b' }] } } } };
}
function finish(runId: string) {
  useGraphStore.getState().handleExecutionEvent({ type: 'graphComplete', runId, duration: 2, nodesExecuted: 1 });
}

describe('shared concurrent run ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useGraphStore.getState().resetExecution();
    localStorage.clear();
    useGraphStore.setState({ nodes: [model('one'), model('two')], edges: [], runHistory: [], providerStartAmbiguities: [] });
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' });
    vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' });
    vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' });
    vi.spyOn(api, 'cancelExecution').mockResolvedValue({ status: 'cancelled', runId: '' });
    vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ status: 'running', runId: '' });
  });
  afterEach(() => { useGraphStore.getState().resetExecution(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it('records distinct jobs, keeps remaining ownership, and ignores late old node events', async () => {
    await useGraphStore.getState().executeClusterConcurrent(['one']);
    await useGraphStore.getState().executeClusterConcurrent(['two']);
    const [one, two] = vi.mocked(api.executeGraph).mock.calls.map((args) => args[2]!);
    expect(useGraphStore.getState().activeRuns).toHaveLength(2);
    expect(useGraphStore.getState().runHistory).toHaveLength(2);
    finish(one);
    expect(useGraphStore.getState().isExecuting).toBe(true);
    expect(useGraphStore.getState().activeRuns.map((run) => run.id)).toEqual([two]);
    await useGraphStore.getState().executeClusterConcurrent(['one']);
    useGraphStore.getState().handleExecutionEvent({ type: 'executed', runId: one, nodeId: 'one', outputs: {} });
    expect(useGraphStore.getState().nodes[0].data.state).toBe('queued');
    useGraphStore.getState().handleExecutionEvent({ type: 'error', runId: two, nodeId: 'two', error: 'failed' });
    finish(two);
    expect(useGraphStore.getState().runHistory.find((run) => run.id === two)?.status).toBe('failed');
    expect(useGraphStore.getState().runHistory.find((run) => run.id === one)?.status).toBe('complete');
  });

  it.each(['failed', 'cancelled'] as const)('retains cumulative iterator results in a %s run while previews remain scalar', async (status) => {
    await useGraphStore.getState().executeClusterConcurrent(['one']);
    const runId = useGraphStore.getState().activeRuns[0].id;
    await getBackendBaseUrl();
    const first = { image: { type: 'Image' as const, value: '/Users/fixture/output/run/item1.png' } };
    const second = { image: { type: 'Image' as const, value: '/api/outputs/run/item2.png' } };
    useGraphStore.getState().handleExecutionEvent({ type: 'executed', runId, nodeId: 'one', outputs: first, batchOutputs: [first] });
    useGraphStore.getState().handleExecutionEvent({ type: 'executed', runId, nodeId: 'one', outputs: second, batchOutputs: [first, second] });
    const state = useGraphStore.getState();
    expect(state.nodes[0].data.outputs.image.value).toBe('http://localhost:8000/api/outputs/run/item2.png');
    expect(state.runHistory[0].batchOutputs?.one.map((outputs) => outputs.image.value)).toEqual([
      'http://localhost:8000/api/outputs/run/item1.png', 'http://localhost:8000/api/outputs/run/item2.png',
    ]);
    expect(Object.isFrozen(state.runHistory[0].batchOutputs?.one[0].image)).toBe(true);
    if (status === 'cancelled') await state.cancelRun(runId);
    else {
      state.handleExecutionEvent({ type: 'error', runId, nodeId: 'one', error: 'Third item failed', retryable: false });
      finish(runId);
    }
    expect(useGraphStore.getState().runHistory[0].status).toBe(status);
    expect(useGraphStore.getState().runHistory[0].batchOutputs?.one).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem('nebula:run-history:v1') ?? '{}').records?.[0]?.batchOutputs?.one).toHaveLength(2);
  });

  it('settles zero-item iterator descendants without clearing previous outputs or another run', async () => {
    const iterator = { ...model('iterator'), data: { ...model('iterator').data, definitionId: 'iterator' } };
    const downstream = { ...model('one'), data: { ...model('one').data, outputs: { image: { type: 'Image' as const, value: '/api/outputs/previous.png' } } } };
    useGraphStore.setState({ nodes: [iterator, downstream, model('two')], edges: [
      { id: 'iterator-one', source: 'iterator', target: 'one', sourceHandle: 'item', targetHandle: 'prompt' },
    ] });
    await useGraphStore.getState().executeClusterConcurrent(['iterator', 'one']);
    const runId = useGraphStore.getState().activeRuns[0].id;
    await useGraphStore.getState().executeClusterConcurrent(['two']);
    useGraphStore.getState().handleExecutionEvent({ type: 'executed', runId, nodeId: 'iterator', outputs: {}, batchOutputs: [] });
    finish(runId);
    const state = useGraphStore.getState();
    expect(state.nodes.find((node) => node.id === 'iterator')?.data.state).toBe('complete');
    expect(state.nodes.find((node) => node.id === 'one')?.data.state).toBe('idle');
    expect(state.nodes.find((node) => node.id === 'one')?.data.outputs).toEqual(downstream.data.outputs);
    expect(state.nodes.find((node) => node.id === 'two')?.data.state).toBe('queued');
    expect(state.isExecuting).toBe(true);
    expect(state.runHistory.find((run) => run.id === runId)).toMatchObject({ status: 'complete', durationSec: 2, nodesExecuted: 1, batchOutputs: { iterator: [] } });
  });

  it('settles descendants blocked by a later batch error while retaining earlier scalar and batch results', async () => {
    useGraphStore.setState({ nodes: [model('one'), model('blocked'), model('two')], edges: [
      { id: 'one-blocked', source: 'one', target: 'blocked', sourceHandle: 'image', targetHandle: 'images' },
    ] });
    await useGraphStore.getState().executeClusterConcurrent(['one', 'blocked']);
    const runId = useGraphStore.getState().activeRuns[0].id;
    await useGraphStore.getState().executeClusterConcurrent(['two']);
    const outputs = { image: { type: 'Image' as const, value: '/api/outputs/first-item.png' } };
    useGraphStore.getState().handleExecutionEvent({ type: 'executed', runId, nodeId: 'one', outputs, batchOutputs: [outputs] });
    useGraphStore.getState().handleExecutionEvent({ type: 'error', runId, nodeId: 'one', error: 'Second item failed', retryable: false });
    useGraphStore.getState().updateNodeData('blocked', { progress: 0.2, streamingText: 'partial', streamingSvg: { index: 0, svg: '<svg/>', isFinal: false } });
    finish(runId);
    const state = useGraphStore.getState();
    expect(state.nodes.find((node) => node.id === 'one')?.data).toMatchObject({ state: 'error', error: 'Second item failed', outputs: { image: { value: expect.stringContaining('first-item.png') } } });
    expect(state.nodes.find((node) => node.id === 'blocked')?.data).toMatchObject({ state: 'idle', progress: undefined, streamingText: undefined, streamingSvg: undefined });
    expect(state.nodes.find((node) => node.id === 'two')?.data.state).toBe('queued');
    expect(state.runHistory.find((run) => run.id === runId)?.status).toBe('failed');
    expect(state.runHistory.find((run) => run.id === runId)?.batchOutputs?.one).toHaveLength(1);
  });

  it('blocks overlapping nodes and global Stop cancels all owned runs', async () => {
    await useGraphStore.getState().executeClusterConcurrent(['one']);
    await useGraphStore.getState().executeClusterConcurrent(['one']);
    await useGraphStore.getState().executeClusterConcurrent(['two']);
    expect(api.executeGraph).toHaveBeenCalledTimes(2);
    await useGraphStore.getState().cancelExecution();
    expect(api.cancelExecution).toHaveBeenCalledTimes(2);
    expect(useGraphStore.getState().runHistory.map((run) => run.status)).toEqual(['cancelled', 'cancelled']);
    expect(useGraphStore.getState().activeRuns).toEqual([]);
    expect(useGraphStore.getState().isExecuting).toBe(false);
  });

  it('keeps cancellation intent when Stop precedes start admission', async () => {
    let resolve!: (value: { status: string }) => void;
    vi.mocked(api.executeGraph).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    vi.mocked(api.cancelExecution).mockRejectedValueOnce(new Error('not registered yet'));
    const pending = useGraphStore.getState().executeClusterConcurrent(['one']);
    const id = useGraphStore.getState().activeRuns[0].id;
    await useGraphStore.getState().cancelRun(id);
    expect(useGraphStore.getState().activeRuns[0].status).toBe('cancelling');
    resolve({ status: 'started' });
    await pending;
    expect(api.cancelExecution).toHaveBeenCalledTimes(2);
    expect(useGraphStore.getState().runHistory[0].status).toBe('cancelled');
  });

  it('reserves Create launch slots and atomically transfers immutable origin to history', async () => {
    const store = useGraphStore.getState();
    expect(store.reserveCreateGeneration('g1')).toBe(true);
    expect(store.reserveCreateGeneration('g2')).toBe(true);
    expect(store.reserveCreateGeneration('g3')).toBe(false);
    const origin = { genId: 'g1', sessionId: 's', prompt: 'cat', ts: 123, modelNodeIds: ['one'], allNodeIds: ['one'] };
    await store.executeClusterConcurrent(['one'], origin);
    origin.modelNodeIds.push('two');
    expect(useGraphStore.getState().createLaunchingIds).toEqual(['g2']);
    expect(useGraphStore.getState().runHistory[0].createOrigin?.modelNodeIds).toEqual(['one']);
    expect(store.reserveCreateGeneration('g3')).toBe(false);
    finish(useGraphStore.getState().activeRuns[0].id);
    expect(store.reserveCreateGeneration('g3')).toBe(true);
    store.releaseCreateGeneration('g2');
    store.releaseCreateGeneration('g2');
  });

  it('allows distinct Cinema shots, blocks duplicates and records terminal failures', async () => {
    useGraphStore.setState({ nodes: [cinema()] });
    await useGraphStore.getState().executeShot('scene', 'a', 4, 3);
    await useGraphStore.getState().executeShot('scene', 'a');
    expect(useGraphStore.getState().isShotAdmissionBlocked('scene', 'b')).toBe(false);
    await useGraphStore.getState().executeShot('scene', 'b');
    expect(api.generateCinemaShot).toHaveBeenCalledTimes(2);
    const [a, b] = vi.mocked(api.generateCinemaShot).mock.calls.map((args) => args[6]!);
    expect(useGraphStore.getState().activeRuns.map((run) => run.shotId)).toEqual(['a', 'b']);
    useGraphStore.getState().hydrateExecutionStatuses([{ runId: a, status: 'failed' }]);
    expect(useGraphStore.getState().runHistory.find((run) => run.id === a)?.status).toBe('failed');
    expect(useGraphStore.getState().activeRuns[0].id).toBe(b);
    expect(useGraphStore.getState().runHistory.find((run) => run.id === a)?.cinemaShot).toEqual({ nodeId: 'scene', shotId: 'a', seed: 4, variations: 3 });
    await useGraphStore.getState().cancelRun(b);
    const scene = useGraphStore.getState().nodes[0].data.params.scene as { shots: { id: string; output: { status: string } }[] };
    expect(scene.shots.find((shot) => shot.id === 'b')?.output.status).toBe('idle');
  });

  it('blocks graph overlap with Cinema and reconciles shots without graphComplete events', async () => {
    useGraphStore.setState({ nodes: [cinema()] });
    await useGraphStore.getState().executeShot('scene', 'a');
    await useGraphStore.getState().executeClusterConcurrent(['scene']);
    expect(api.executeGraph).not.toHaveBeenCalled();
    vi.mocked(api.getExecutionStatus).mockResolvedValue({ runId: '', status: 'completed' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(useGraphStore.getState().runHistory[0].status).toBe('complete');
    expect(useGraphStore.getState().isExecuting).toBe(false);
  });

  it('global Stop during Create preparation prevents the eventual model launch', async () => {
    const store = useGraphStore.getState();
    store.reserveCreateGeneration('preparing');
    expect(useGraphStore.getState().isExecuting).toBe(true);
    await store.cancelExecution();
    expect(useGraphStore.getState().isCancelling).toBe(true);
    expect(useGraphStore.getState().createLaunchingIds).toEqual(['preparing']);
    await store.executeClusterConcurrent(['one'], { genId: 'preparing', sessionId: 's', prompt: '', ts: 1, modelNodeIds: ['one'], allNodeIds: ['one'] });
    expect(api.executeGraph).not.toHaveBeenCalled();
    store.releaseCreateGeneration('preparing');
    expect(useGraphStore.getState().isExecuting).toBe(false);
    expect(useGraphStore.getState().isCancelling).toBe(false);
  });

  it('a late graphSync cannot restore a cancelled Cinema spinner', async () => {
    const sceneNode = { ...cinema(), id: 'n1' };
    useGraphStore.setState({ nodes: [sceneNode] });
    await useGraphStore.getState().executeShot(sceneNode.id, 'a');
    const id = useGraphStore.getState().activeRuns[0].id;
    const stale = JSON.parse(JSON.stringify(useGraphStore.getState().nodes));
    await useGraphStore.getState().cancelRun(id);
    const callback = vi.mocked(wsClient.subscribe).mock.calls[0][0];
    callback({ type: 'graphSync', nodes: stale, edges: [], empty: false, executionStatuses: [{ runId: id, status: 'cancelled' }] });
    const scene = useGraphStore.getState().nodes[0].data.params.scene as { shots: { id: string; output?: { status: string } }[] };
    expect(scene.shots.find((shot) => shot.id === 'a')?.output?.status).toBe('idle');
  });

  it('replays Cinema history through the shot endpoint from saved request data', async () => {
    useGraphStore.setState({ nodes: [cinema()] });
    await useGraphStore.getState().executeShot('scene', 'a', 4, 3);
    const source = useGraphStore.getState().runHistory[0];
    useGraphStore.getState().hydrateExecutionStatuses([{ runId: source.id, status: 'failed' }]);
    useGraphStore.setState({ nodes: [{ ...cinema(), data: { ...cinema().data, params: { edited: true } } }] });
    await useGraphStore.getState().rerunHistoryRecord(source.id);
    expect(api.executeGraph).not.toHaveBeenCalled();
    expect(api.generateCinemaShot).toHaveBeenCalledTimes(2);
    const [savedNodes, , nodeId, shotId, seed, count] = vi.mocked(api.generateCinemaShot).mock.calls[1];
    expect(savedNodes).toEqual(source.snapshot.nodes);
    expect([nodeId, shotId, seed, count]).toEqual(['scene', 'a', 4, 3]);
    expect(useGraphStore.getState().runHistory[0].cinemaShot).toEqual(source.cinemaShot);
    expect(useGraphStore.getState().activeRuns[0].kind).toBe('cinema-shot');
  });

  it('shares static Cinema inputs but blocks a shared generator ancestor', async () => {
    const input = { ...model('input'), data: { ...model('input').data, definitionId: 'image-input' } };
    useGraphStore.setState({ nodes: [input, cinema()], edges: [{ id: 'e', source: 'input', target: 'scene' }] });
    await useGraphStore.getState().executeShot('scene', 'a');
    await useGraphStore.getState().executeShot('scene', 'b');
    expect(api.generateCinemaShot).toHaveBeenCalledTimes(2);
    useGraphStore.getState().resetExecution();
    vi.mocked(api.generateCinemaShot).mockClear();
    useGraphStore.setState({ nodes: [model('paid'), cinema()], edges: [{ id: 'e', source: 'paid', target: 'scene' }] });
    await useGraphStore.getState().executeShot('scene', 'a', 1, 3);
    expect(useGraphStore.getState().isShotAdmissionBlocked('scene', 'b')).toBe(true);
    await useGraphStore.getState().executeShot('scene', 'b', 2, 3);
    expect(api.generateCinemaShot).toHaveBeenCalledTimes(1);
  });

  it.each(['graph', 'node', 'cluster', 'replay'] as const)('retains %s ownership after an ambiguous accepted start', async (mode) => {
    vi.mocked(api.executeGraph).mockRejectedValue(new Error('HTTP 503 acknowledgement lost'));
    vi.mocked(api.executeNode).mockRejectedValue(new Error('HTTP 503 acknowledgement lost'));
    vi.mocked(api.getExecutionStatus).mockRejectedValue(new Error('temporarily unavailable'));
    const store = useGraphStore.getState();
    if (mode === 'graph') await store.executeGraph();
    if (mode === 'node') await store.executeNode('one');
    if (mode === 'cluster') await store.executeCluster(['one']);
    if (mode === 'replay') {
      vi.mocked(api.executeGraph).mockResolvedValueOnce({ status: 'started' });
      await store.executeCluster(['one']);
      const source = useGraphStore.getState().runHistory[0];
      finish(source.id);
      await store.rerunHistoryRecord(source.id);
    }
    expect(useGraphStore.getState().activeRuns[0]?.status).toBe('uncertain');
    expect(useGraphStore.getState().runHistory[0].status).toBe('running');
    const launches = vi.mocked(api.executeGraph).mock.calls.length + vi.mocked(api.executeNode).mock.calls.length;
    await store.executeClusterConcurrent(['one']);
    expect(vi.mocked(api.executeGraph).mock.calls.length + vi.mocked(api.executeNode).mock.calls.length).toBe(launches);
    await store.cancelExecution();
    expect(useGraphStore.getState().isExecuting).toBe(false);
  });

  it('annotates external CLI validation errors without releasing a local owner', async () => {
    await useGraphStore.getState().executeClusterConcurrent(['one']);
    useGraphStore.getState().handleExecutionEvent({ type: 'validationError', runId: 'external', errors: [
      { nodeId: 'two', portId: '', message: 'CLI missing prompt' },
      { nodeId: 'one', portId: '', message: 'Unrelated stale validation' },
    ] });
    expect(useGraphStore.getState().nodes[1].data.error).toBe('CLI missing prompt');
    expect(useGraphStore.getState().nodes[0].data.state).toBe('queued');
    expect(useGraphStore.getState().activeRuns).toHaveLength(1);
  });

  it.each(['running', 'cancelling'] as const)('clears only reconnecting advisories when polling confirms %s', async (status) => {
    await useGraphStore.getState().executeClusterConcurrent(['one']);
    await useGraphStore.getState().executeClusterConcurrent(['two']);
    const [first, second] = useGraphStore.getState().activeRuns.map((run) => run.id);
    const diagnostic: RunRecord = { ...useGraphStore.getState().runHistory[0], id: 'prior-failure', status: 'failed', statusNote: 'Prior provider failure: recovery ID was not saved.' };
    useGraphStore.setState((state) => ({ runHistory: [
      ...state.runHistory.map((record) => ({ ...record, statusNote: record.id === first ? EXECUTION_RECONNECTING_NOTE : WORLD_LABS_RECONNECTING_NOTE })),
      diagnostic,
    ] }));
    vi.mocked(api.getExecutionStatus).mockResolvedValue({ runId: '', status });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(useGraphStore.getState().activeRuns).toHaveLength(2);
    expect(useGraphStore.getState().runHistory.find((record) => record.id === first)?.statusNote).toBeUndefined();
    expect(useGraphStore.getState().runHistory.find((record) => record.id === second)?.statusNote).toBeUndefined();
    expect(useGraphStore.getState().runHistory.find((record) => record.id === diagnostic.id)?.statusNote).toBe(diagnostic.statusNote);
  });

  it('clears a hydrated reconnecting note while preserving an active provider diagnostic', async () => {
    await useGraphStore.getState().executeClusterConcurrent(['one']);
    await useGraphStore.getState().executeClusterConcurrent(['two']);
    const [first, second] = useGraphStore.getState().activeRuns.map((run) => run.id);
    const warning = 'Recovery ID captured, but could not be saved durably.';
    useGraphStore.setState((state) => ({ runHistory: state.runHistory.map((record) => ({ ...record,
      statusNote: record.id === first ? EXECUTION_RECONNECTING_NOTE : warning,
    })) }));
    useGraphStore.getState().hydrateExecutionStatuses([{ runId: first, status: 'running' }, { runId: second, status: 'cancelling' }]);
    expect(useGraphStore.getState().runHistory.find((record) => record.id === first)?.statusNote).toBeUndefined();
    expect(useGraphStore.getState().runHistory.find((record) => record.id === second)?.statusNote).toBe(warning);
    expect(useGraphStore.getState().activeRuns.map((run) => run.id)).toEqual([first, second]);
  });
});
