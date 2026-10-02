import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import * as api from '../src/lib/api';
import { loadRunHistory, RUN_HISTORY_STORAGE_KEY } from '../src/lib/runHistory';
import type { PaperSourceRecord } from '../src/lib/paperSource';

function source(hash: string, sequence: number, objectId = 'logo'): PaperSourceRecord {
  const identity = {
    fileId: 'file', pageId: 'page', objectId, fileName: 'Brand', pageName: 'Logos',
    objectName: 'Editable logo', openUrl: 'https://app.paper.design/file', navigation: 'file' as const,
  };
  const exportSettings = { format: 'png' as const, scale: '2x' as const, bounds: 'object' as const, background: 'artwork' as const };
  const snapshot = {
    id: `snapshot-${hash}`, hash, capturedAt: `2026-10-01T12:00:0${sequence}Z`,
    width: 400, height: 200, hasAlpha: true, hasTransparency: true,
    filePath: `/api/outputs/paper/${hash}.png`, previewUrl: `/api/outputs/paper/${hash}.png`,
    identity, exportSettings,
  };
  return { id: 'source', identity, exportSettings, snapshot, snapshots: [snapshot], state: 'current', sequence };
}

function setGraph() {
  const linked = source('A', 1);
  useGraphStore.setState({
    nodes: [
      { id: 'paper', type: 'paperSourceNode', position: { x: 0, y: 0 }, data: {
        label: 'Paper logo', definitionId: 'paper-source', params: { _paperSource: linked }, state: 'complete',
        outputs: { image: { type: 'Image', value: linked.snapshot!.filePath } },
      } },
      { id: 'recipe', type: 'model-node', position: { x: 300, y: 0 }, data: {
        label: 'Deterministic fixture', definitionId: 'preview', params: { seed: 7, mode: 'unchanged' }, state: 'idle', outputs: {},
      } },
    ],
    edges: [{ id: 'paper-recipe', source: 'paper', sourceHandle: 'image', target: 'recipe', targetHandle: 'input' }],
  });
}

function node(id: string) {
  return useGraphStore.getState().nodes.find((candidate) => candidate.id === id)!;
}

function complete(runId: string, hash: string) {
  const store = useGraphStore.getState();
  store.handleExecutionEvent({ type: 'executed', runId, nodeId: 'paper', outputs: {
    image: { type: 'Image', value: `/api/outputs/paper/${hash}.png` },
  } });
  store.handleExecutionEvent({ type: 'executed', runId, nodeId: 'recipe', outputs: {
    image: { type: 'Image', value: `/api/outputs/fixture/${hash}.png` },
  } });
  store.handleExecutionEvent({ type: 'graphComplete', runId, duration: 0.01, nodesExecuted: 2 });
}

describe('Paper source execution contract', () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isCancelling: false,
      providerRecoveries: [], providerStartAmbiguities: [], uncertainWorldLabsRunId: null, providerRecoveryWarning: null });
    window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
    vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' });
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' });
    vi.spyOn(window, 'alert').mockImplementation(() => {});
    setGraph();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('pins source A, retains its output/history, and refreshes B without generation or edge loss', async () => {
    await useGraphStore.getState().executeNode('recipe');
    const first = useGraphStore.getState().runHistory[0];
    complete(first.id, 'A');
    const beforeEdges = useGraphStore.getState().edges;
    const beforeOutput = node('recipe').data.outputs;

    useGraphStore.getState().applyPaperSource('paper', source('B', 2));

    expect(api.executeNode).toHaveBeenCalledTimes(1);
    expect(api.executeGraph).not.toHaveBeenCalled();
    expect(useGraphStore.getState().edges).toBe(beforeEdges);
    expect(node('recipe').data.outputs).toBe(beforeOutput);
    expect(node('paper').data.outputs.image.value).toBe('/api/outputs/paper/B.png');
    expect(node('recipe').data.outputFreshness?.outOfDateReasons).toEqual([
      'Paper source paper updated after this input was captured.',
    ]);
    const saved = useGraphStore.getState().runHistory[0];
    expect(saved.paperInputs?.[0].snapshot.hash).toBe('A');
    expect(saved.resultOutputs?.recipe.image.value).toEqual(expect.stringContaining('/api/outputs/fixture/A.png'));
    expect(saved.recipeRevision).toMatch(/^recipe-v1-/);
    expect(Object.isFrozen(saved.paperInputs?.[0].snapshot)).toBe(true);
    expect(Object.isFrozen(saved.resultOutputs?.recipe)).toBe(true);
  });

  it('an unchanged hash, rename, or failed refresh leaves dependent results current', async () => {
    await useGraphStore.getState().executeNode('recipe');
    complete(useGraphStore.getState().runHistory[0].id, 'A');
    const unchanged = source('A', 2);
    unchanged.identity.objectName = 'Renamed logo';
    useGraphStore.getState().applyPaperSource('paper', unchanged);
    useGraphStore.getState().applyPaperSource('paper', { ...unchanged, sequence: 3, state: 'unavailable', lastError: 'Paper Desktop disconnected.' });

    expect(node('recipe').data.outputFreshness?.outOfDateReasons).toEqual([]);
    expect(useGraphStore.getState().runHistory[0].outOfDateReasons).toEqual([]);
    expect(node('paper').data.outputs.image.value).toBe('/api/outputs/paper/A.png');
    expect((node('paper').data.params._paperSource as PaperSourceRecord).lastError).toMatch(/disconnected/);
    expect(api.executeNode).toHaveBeenCalledTimes(1);
  });

  it('finishes A against its pinned input after refresh to B during the run', async () => {
    await useGraphStore.getState().executeNode('recipe');
    const running = useGraphStore.getState().runHistory[0];
    useGraphStore.getState().applyPaperSource('paper', source('B', 2));
    complete(running.id, 'A');

    const submitted = vi.mocked(api.executeNode).mock.calls[0][0];
    expect((submitted[0].params._paperSource as PaperSourceRecord).snapshot?.hash).toBe('A');
    expect(node('paper').data.outputs.image.value).toBe('/api/outputs/paper/B.png');
    expect(node('recipe').data.outputs.image.value).toEqual(expect.stringContaining('/api/outputs/fixture/A.png'));
    expect(node('recipe').data.outputFreshness?.outOfDateReasons).toHaveLength(1);
    expect(useGraphStore.getState().runHistory[0]).toMatchObject({ status: 'complete', paperInputs: [{ snapshot: { hash: 'A' } }] });
  });

  it('explicitly reruns the saved recipe with B while retaining A and ignoring live settings edits', async () => {
    await useGraphStore.getState().executeNode('recipe');
    const firstId = useGraphStore.getState().runHistory[0].id;
    complete(firstId, 'A');
    useGraphStore.getState().applyPaperSource('paper', source('B', 2));
    useGraphStore.getState().updateNodeData('recipe', { params: { seed: 99, mode: 'changed on canvas' } });

    await useGraphStore.getState().rerunHistoryWithLatestPaperSource(firstId);
    const second = useGraphStore.getState().runHistory[0];
    const secondRequest = vi.mocked(api.executeNode).mock.calls[1][0];
    expect(vi.mocked(api.executeNode).mock.calls[1][4]).toBe(true);
    expect(vi.mocked(api.executeNode).mock.calls[0][4]).toBeUndefined();
    expect((secondRequest[0].params._paperSource as PaperSourceRecord).snapshot?.hash).toBe('B');
    expect(secondRequest[1].params).toEqual({ seed: 7, mode: 'unchanged' });
    expect(second.replayAction).toBe('latest-paper-source');
    expect(second.sourceRunId).toBe(firstId);
    expect(second.recipeRevision).toBe(useGraphStore.getState().runHistory[1].recipeRevision);
    complete(second.id, 'B');
    const history = useGraphStore.getState().runHistory;
    expect(history).toHaveLength(2);
    expect(history.map((run) => run.paperInputs?.[0].snapshot.hash)).toEqual(['B', 'A']);
    expect(history[1].resultOutputs?.recipe.image.value).toEqual(expect.stringContaining('/api/outputs/fixture/A.png'));
    expect(history[0].resultOutputs?.recipe.image.value).toEqual(expect.stringContaining('/api/outputs/fixture/B.png'));
    expect((node('recipe').data.params).seed).toBe(99);
    const loaded = loadRunHistory();
    expect(loaded.map((run) => run.paperInputs?.[0].snapshot.hash)).toEqual(['B', 'A']);
    expect(Object.isFrozen(loaded[1].resultOutputs?.recipe)).toBe(true);
  });

  it('historical exact replay retains A even though the current Paper source is B', async () => {
    await useGraphStore.getState().executeNode('recipe');
    const id = useGraphStore.getState().runHistory[0].id;
    complete(id, 'A');
    useGraphStore.getState().applyPaperSource('paper', source('B', 2));
    await useGraphStore.getState().rerunHistoryRecord(id);
    expect(vi.mocked(api.executeNode).mock.calls[1][4]).toBe(true);
    expect((vi.mocked(api.executeNode).mock.calls[1][0][0].params._paperSource as PaperSourceRecord).snapshot?.hash).toBe('A');
    expect(useGraphStore.getState().runHistory[0].outOfDateReasons).toHaveLength(1);
  });

  it('opts full-graph historical replay into preserving edited live params', async () => {
    await useGraphStore.getState().executeGraph();
    const id = useGraphStore.getState().runHistory[0].id;
    complete(id, 'A');
    useGraphStore.getState().updateNodeData('recipe', { params: { seed: 99 } });
    await useGraphStore.getState().rerunHistoryRecord(id);
    const calls = vi.mocked(api.executeGraph).mock.calls;
    expect(calls[0][3]).toBeUndefined();
    expect(calls[1][3]).toBe(true);
    expect(calls[1][0][1].params).toEqual({ seed: 7, mode: 'unchanged' });
    expect(node('recipe').data.params).toEqual({ seed: 99 });
  });

  it('rejects late refresh responses, retains missing-object preview and requires a current source to rerun', async () => {
    await useGraphStore.getState().executeNode('recipe');
    const id = useGraphStore.getState().runHistory[0].id;
    complete(id, 'A');
    useGraphStore.getState().applyPaperSource('paper', source('B', 3));
    useGraphStore.getState().applyPaperSource('paper', source('A', 2));
    useGraphStore.getState().applyPaperSource('paper', { ...source('B', 4), state: 'missing', lastError: 'Linked object was deleted.' });
    expect(node('paper').data.outputs.image.value).toBe('/api/outputs/paper/B.png');
    await useGraphStore.getState().rerunHistoryWithLatestPaperSource(id);
    expect(api.executeNode).toHaveBeenCalledTimes(1);
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Refresh or reconnect'));
    useGraphStore.getState().applyPaperSource('paper', source('B', 5, 'replacement-logo'));
    expect(useGraphStore.getState().runHistory[0].outOfDateReasons).toEqual([
      'Paper source paper was reconnected to another object.',
    ]);
  });

  it('marks the saved output stale when recipe settings change without a Paper change', async () => {
    await useGraphStore.getState().executeNode('recipe');
    complete(useGraphStore.getState().runHistory[0].id, 'A');
    useGraphStore.getState().updateNodeData('recipe', { params: { seed: 8 } });
    expect(node('recipe').data.outputFreshness?.outOfDateReasons).toEqual([
      'Recipe settings or connections changed after this run was saved.',
    ]);
    expect(node('recipe').data.outputs.image.value).toEqual(expect.stringContaining('/api/outputs/fixture/A.png'));
  });

  it('does not rewind a newer source when a delayed backend graphSync contains A', () => {
    vi.useFakeTimers();
    try {
      const original = node('paper');
      useGraphStore.setState({ nodes: [{ ...original, id: 'n1' }], edges: [] });
      useGraphStore.getState().applyPaperSource('n1', source('B', 3));
      const subscribed = vi.mocked(wsClient.subscribe).mock.calls[0][0] as (event: ExecutionEvent) => void;
      subscribed({ type: 'graphSync', empty: false, nodes: [{ ...original, id: 'n1', type: 'model-node' }], edges: [] });
      expect((node('n1').data.params._paperSource as PaperSourceRecord).snapshot?.hash).toBe('B');
      expect(node('n1').data.outputs.image.value).toBe('/api/outputs/paper/B.png');
      expect(node('n1').type).toBe('paperSourceNode');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('restores stale attribution when canvas nodes reload without frontend output metadata', async () => {
    await useGraphStore.getState().executeNode('recipe');
    complete(useGraphStore.getState().runHistory[0].id, 'A');
    useGraphStore.getState().applyPaperSource('paper', source('B', 2));
    const state = useGraphStore.getState();
    const reloaded = state.nodes.map((candidate) => ({ ...candidate, data: { ...candidate.data, outputFreshness: undefined } }));
    useGraphStore.setState({ nodes: reloaded, runHistory: loadRunHistory() });
    expect(node('recipe').data.outputFreshness).toMatchObject({
      paperInputs: [{ snapshot: { hash: 'A' } }],
      outOfDateReasons: ['Paper source paper updated after this input was captured.'],
    });
    expect(node('recipe').data.outputs.image.value).toEqual(expect.stringContaining('/api/outputs/fixture/A.png'));
  });

  it('keeps the first completed Video run current after the backend adds output-probe metadata', async () => {
    await useGraphStore.getState().executeNode('recipe');
    const runId = useGraphStore.getState().runHistory[0].id;
    useGraphStore.getState().handleExecutionEvent({ type: 'executed', runId, nodeId: 'recipe', outputs: {
      video: { type: 'Video', value: '/api/outputs/fixture/A.mp4' },
    } });
    // Mirrors engine._maybe_probe_video_output followed by live graphSync.
    useGraphStore.getState().updateNodeData('recipe', { params: {
      ...node('recipe').data.params, _sourceDuration: 1.2, _sourceFps: 30, _sourceIsVfr: false,
    } });
    useGraphStore.getState().handleExecutionEvent({ type: 'graphComplete', runId, duration: 0.02, nodesExecuted: 2 });
    expect(useGraphStore.getState().runHistory[0].outOfDateReasons).toEqual([]);
    expect(node('recipe').data.outputFreshness?.outOfDateReasons).toEqual([]);
    // Actual saved settings still affect freshness despite those metadata keys.
    useGraphStore.getState().updateNodeData('recipe', { params: { ...node('recipe').data.params, seed: 8 } });
    expect(node('recipe').data.outputFreshness?.outOfDateReasons).toEqual([
      'Recipe settings or connections changed after this run was saved.',
    ]);
  });

  it('retains full live source history and B preview across latest-source and old-snapshot replay syncs', async () => {
    vi.useFakeTimers();
    try {
      const initialNodes = useGraphStore.getState().nodes.map((candidate) => ({
        ...candidate, id: candidate.id === 'paper' ? 'n1' : 'n2',
      }));
      const edges = [{ id: 'n1-n2', source: 'n1', sourceHandle: 'image', target: 'n2', targetHandle: 'input' }];
      useGraphStore.setState({ nodes: initialNodes, edges });
      await useGraphStore.getState().executeNode('n2');
      const firstId = useGraphStore.getState().runHistory[0].id;
      useGraphStore.getState().handleExecutionEvent({ type: 'graphComplete', runId: firstId, duration: 0.01, nodesExecuted: 2 });
      const latest = source('B', 2);
      latest.snapshots = [source('A', 1).snapshot!, latest.snapshot!];
      useGraphStore.getState().applyPaperSource('n1', latest);
      await useGraphStore.getState().rerunHistoryWithLatestPaperSource(firstId);
      const second = useGraphStore.getState().runHistory[0];
      const submittedLatest = vi.mocked(api.executeNode).mock.calls[1][0][0].params._paperSource as PaperSourceRecord;
      expect(submittedLatest.snapshots).toHaveLength(1);
      const subscribed = vi.mocked(wsClient.subscribe).mock.calls[0][0] as (event: ExecutionEvent) => void;
      subscribed({ type: 'graphSync', empty: false, nodes: [
        { ...node('n1'), data: { ...node('n1').data, params: { _paperSource: submittedLatest } } }, node('n2'),
      ], edges });
      expect((node('n1').data.params._paperSource as PaperSourceRecord).snapshots.map((snapshot) => snapshot.hash)).toEqual(['A', 'B']);
      expect(node('n1').data.outputs.image.value).toBe('/api/outputs/paper/B.png');
      useGraphStore.getState().handleExecutionEvent({ type: 'graphComplete', runId: second.id, duration: 0.01, nodesExecuted: 2 });
      await useGraphStore.getState().rerunHistoryRecord(firstId);
      const submittedOld = vi.mocked(api.executeNode).mock.calls[2][0][0].params._paperSource as PaperSourceRecord;
      expect(submittedOld.snapshot?.hash).toBe('A');
      subscribed({ type: 'graphSync', empty: false, nodes: [
        { ...node('n1'), data: { ...node('n1').data, params: { _paperSource: submittedOld } } }, node('n2'),
      ], edges });
      expect((node('n1').data.params._paperSource as PaperSourceRecord).snapshots.map((snapshot) => snapshot.hash)).toEqual(['A', 'B']);
      expect(node('n1').data.outputs.image.value).toBe('/api/outputs/paper/B.png');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
