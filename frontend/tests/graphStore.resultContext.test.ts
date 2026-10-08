import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import type { NodeData, PortValue } from '../src/types';
import * as api from '../src/lib/api';
import { loadRunHistory, RUN_HISTORY_STORAGE_KEY, type RunRecord } from '../src/lib/runHistory';
import { resultContextForNode } from '../src/lib/resultContext';
import { useGraphStore } from '../src/store/graphStore';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

function node(id: string, definitionId: string, params: Record<string, unknown> = {}): Node<NodeData> {
  return { id, position: { x: 0, y: 0 }, data: { label: id, definitionId, params, outputs: {}, state: 'idle' } };
}
const nodes = () => [node('prompt', 'text-input', { value: 'Original accepted prompt' }),
  node('model', 'nano-banana', { aspect_ratio: '16:9', _variant: 'original-run' })];
const edges: Edge[] = [{ id: 'prompt-model', source: 'prompt', sourceHandle: 'text', target: 'model', targetHandle: 'prompt' }];
const artwork = (): Record<string, PortValue> => ({ image: { type: 'Image', value: '/api/outputs/public-fixture.png' } });
const currentModel = () => useGraphStore.getState().nodes.find((candidate) => candidate.id === 'model')!;
function complete(runId: string) {
  useGraphStore.getState().handleExecutionEvent({ type: 'graphComplete', runId, duration: 1, nodesExecuted: 2 });
}
function emit(nodeId: string, runId: string | undefined, outputs: Record<string, PortValue>) {
  useGraphStore.getState().handleExecutionEvent({ type: 'executed', nodeId, runId, outputs });
}

describe('ordinary executions produce reusable frozen result context', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useGraphStore.getState().resetExecution();
    useGraphStore.getState().releaseGraphImport();
    localStorage.clear();
    useGraphStore.setState({ nodes: nodes(), edges, runHistory: [], providerRecoveries: [],
      providerStartAmbiguities: [], backendFreshStartPending: false, undoStack: [], redoStack: [] });
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' });
    vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' });
  });
  afterEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.getState().releaseGraphImport();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(['create', 'canvas', 'node'] as const)('records %s execution events, closes and reloads an ordinary saved recipe', async (mode) => {
    const origin = { genId: 'generation', sessionId: 'session', prompt: 'Original accepted prompt', ts: 100,
      modelNodeIds: ['model'], allNodeIds: ['prompt', 'model'] };
    if (mode === 'create') {
      expect(useGraphStore.getState().reserveCreateGeneration(origin.genId)).toBe(true);
      await useGraphStore.getState().executeClusterConcurrent(['prompt', 'model'], origin);
    }
    else if (mode === 'canvas') await useGraphStore.getState().executeGraph();
    else await useGraphStore.getState().executeNode('model');
    const runId = useGraphStore.getState().runHistory[0].id;
    const acceptedRecipe = JSON.stringify(useGraphStore.getState().runHistory[0].snapshot);
    emit('prompt', runId, { text: { type: 'Text', value: 'Original accepted prompt' } });
    emit('model', runId, artwork());
    complete(runId);
    const saved = useGraphStore.getState().runHistory[0];
    expect(saved.status).toBe('complete');
    expect(saved.resultOutputs?.prompt.text.value).toBe('Original accepted prompt');
    expect(saved.resultOutputs?.model.image.value).toContain('/api/outputs/public-fixture.png');
    expect(JSON.stringify(saved.snapshot)).toBe(acceptedRecipe);
    useGraphStore.getState().updateNodeData('prompt', { params: { value: 'Edited after completion' } });
    useGraphStore.getState().updateNodeData('model', { params: { aspect_ratio: '1:1' } });
    const reloaded = loadRunHistory();
    const context = resultContextForNode(currentModel(), reloaded);
    expect(context.provenance).toBe('saved-run');
    expect(context.reusableDraft).toMatchObject({ prompt: 'Original accepted prompt', quantity: 1,
      params: { aspect_ratio: '16:9' } });
    expect(context.reusableDraft?.params).not.toHaveProperty('_variant');
    expect(Object.isFrozen(reloaded[0].resultOutputs?.model.image)).toBe(true);
    expect(JSON.parse(localStorage.getItem(RUN_HISTORY_STORAGE_KEY)!).records[0].resultOutputs.model).toEqual(saved.resultOutputs?.model);
    expect(api.executeGraph).toHaveBeenCalledTimes(mode === 'node' ? 0 : 1);
    expect(api.executeNode).toHaveBeenCalledTimes(mode === 'node' ? 1 : 0);
  });

  it('captures ordinary generated upstream prompt/reference outputs, including the same completion shape used by cache hits', async () => {
    useGraphStore.setState({ nodes: [node('prompt', 'claude-chat'), node('reference', 'nano-banana'),
      node('model', 'nano-banana', { aspect_ratio: '16:9' })], edges: [edges[0],
      { id: 'reference-model', source: 'reference', sourceHandle: 'image', target: 'model', targetHandle: 'images' }] });
    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;
    // Cache hits and fresh executions both emit the backend ExecutedEvent contract.
    emit('prompt', runId, { text: { type: 'Text', value: 'Frozen generated prompt' } });
    emit('reference', runId, { image: { type: 'Image', value: '/api/outputs/reference.png' } });
    emit('model', runId, artwork());
    complete(runId);
    useGraphStore.getState().updateNodeData('reference', { outputs: { image: { type: 'Image', value: '/api/outputs/replaced-ref.png' } } });
    const context = resultContextForNode(currentModel(), loadRunHistory());
    expect(context.reusableDraft?.prompt).toBe('Frozen generated prompt');
    expect(context.reusableDraft?.refs.map((ref) => ref.filePath)).toEqual(['/api/outputs/reference.png']);
    expect(api.executeGraph).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'cancelled'] as const)('retains an ordinary successful result when its graph later becomes %s', async (status) => {
    useGraphStore.setState({ nodes: [...nodes(), node('later-node', 'nano-banana')] });
    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;
    emit('model', runId, artwork());
    if (status === 'failed') {
      useGraphStore.getState().handleExecutionEvent({ type: 'error', runId, nodeId: 'later-node', error: 'Public fixture failure', retryable: false });
      complete(runId);
    } else useGraphStore.getState().handleExecutionEvent({ type: 'graphCancelled', runId });
    const reloaded = loadRunHistory();
    expect(reloaded[0].status).toBe(status);
    expect(resultContextForNode(currentModel(), reloaded).reusableDraft?.prompt).toBe('Original accepted prompt');
  });

  it('clones nested incoming values, and ignores late or out-of-snapshot output writes', async () => {
    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;
    const incoming: Record<string, PortValue> = { image: { type: 'Image', value: { url: '/api/outputs/nested.png', mimeType: 'image/png' } } };
    emit('model', runId, incoming);
    const captured = structuredClone(useGraphStore.getState().runHistory[0].resultOutputs);
    (incoming.image.value as { url: string }).url = '/api/outputs/mutated-event.png';
    expect(useGraphStore.getState().runHistory[0].resultOutputs).toEqual(captured);
    expect(Object.isFrozen(useGraphStore.getState().runHistory[0].resultOutputs?.model.image.value)).toBe(true);
    emit('outside-accepted-snapshot', runId, artwork());
    expect(useGraphStore.getState().runHistory[0].resultOutputs).toEqual(captured);
    complete(runId);
    const terminal = useGraphStore.getState().runHistory[0];
    emit('model', runId, { image: { type: 'Image', value: '/api/outputs/late.png' } });
    expect(useGraphStore.getState().runHistory[0]).toBe(terminal);
  });

  it('does not write an unowned persisted run, and supports a legacy event for the current owned Canvas run', async () => {
    const orphan: RunRecord = { id: 'unowned', trigger: 'graph', startedAt: 1, status: 'running', snapshot: {
      nodes: [{ id: 'model', definitionId: 'nano-banana', params: {}, outputs: {} }], edges: [],
    } };
    useGraphStore.setState({ runHistory: [orphan] });
    emit('model', orphan.id, artwork());
    expect(useGraphStore.getState().runHistory[0]).toBe(orphan);
    useGraphStore.setState({ runHistory: [] });
    await useGraphStore.getState().executeGraph();
    const runId = useGraphStore.getState().runHistory[0].id;
    emit('model', undefined, artwork());
    complete(runId);
    expect(resultContextForNode(currentModel(), loadRunHistory()).provenance).toBe('saved-run');
  });
});
