import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import type { ExecutionEvent } from '../src/lib/wsClient';
import { setProjectContext } from '../src/lib/projectContext';
import { loadRunHistory, type RunRecord } from '../src/lib/runHistory';

const transport = vi.hoisted(() => ({ fetch: vi.fn(), sync: null as ((event: ExecutionEvent) => void) | null }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: transport.fetch,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), subscribe: vi.fn((handler) => { transport.sync = handler; }), disconnect: vi.fn(),
} }));
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useCreateDraftStore } from '../src/store/createDraftStore';

function node(value = 'Current', id = 'n1'): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 100 },
    data: { label: 'Text', definitionId: 'text-input', params: { value }, state: 'idle', outputs: {} } };
}
function history(id = 'old-run', status: RunRecord['status'] = 'complete'): RunRecord {
  return { id, status, trigger: 'graph', startedAt: 1,
    snapshot: { nodes: [{ id: 'n1', definitionId: 'text-input', params: { value: id }, outputs: {} }], edges: [] } };
}
function response(body: unknown = {}) { return { ok: true, status: 200, json: async () => body } as Response; }
beforeEach(() => {
  useGraphStore.getState().resetExecution();
  setProjectContext(null);
  useGraphStore.setState({ isImportingGraph: false, providerStartAmbiguities: [], uncertainWorldLabsRunId: null });
  expect(useGraphStore.getState().loadProjectGraph([], [], [], { bootstrap: true })).toBe(true);
  localStorage.clear();
  transport.fetch.mockReset().mockResolvedValue(response());
  vi.spyOn(window, 'alert').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  useGraphStore.getState().resetExecution(); setProjectContext(null);
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe('project graph replacement', () => {
  it('replaces same-ID nodes/history and clears clipboard, editors and stale recovery state', () => {
    setProjectContext({ id: 'A', revision: 'a' });
    useGraphStore.getState().loadProjectGraph([node('A')], [], [history('run-A')]);
    useGraphStore.setState({ clipboard: { nodes: [node('A')], edges: [] },
      providerRecoveries: [{ runId: 'run-A', nodeId: 'n1', resumeOperationId: 'old-job', existingWorldId: null }] });
    useUIStore.setState({ editorTargetNodeId: 'n1', selectedNodeId: 'n1', selectedClipId: 'clip-A',
      isPlaying: true, renderedPreviewUrl: '/outputs/A.mp4', canvasViewport: { x: 10, y: 20, zoom: 1.3 },
      canvasFocusRequest: { nodeId: 'n1', requestId: 'A-focus' }, createSessionId: 'session-A' });
    setProjectContext({ id: 'B', revision: 'b' });
    expect(useGraphStore.getState().loadProjectGraph([node('B')], [], [history('run-B')])).toBe(true);
    expect(useGraphStore.getState()).toMatchObject({ nodes: [node('B')], clipboard: null,
      undoStack: [], redoStack: [], providerRecoveries: [], providerStartAmbiguities: [], isExecuting: false });
    expect(useUIStore.getState()).toMatchObject({ editorTargetNodeId: null, selectedNodeId: null,
      selectedClipId: null, isPlaying: false, renderedPreviewUrl: null, canvasViewport: null,
      canvasFocusRequest: null, createSessionId: null });
    expect(useGraphStore.getState().runHistory.map((run) => run.id)).toEqual(['run-B']);
    expect(Object.isFrozen(useGraphStore.getState().runHistory[0].snapshot)).toBe(true);
    setProjectContext({ id: 'A', revision: 'a-next' });
    expect(loadRunHistory().map((run) => run.id)).toEqual(['run-A']);
  });

  it('preserves paid-run ownership on reload and refuses replacement until a terminal backend status', () => {
    const running = history('paid-run', 'running');
    setProjectContext({ id: 'A', revision: 'a' });
    expect(useGraphStore.getState().loadProjectGraph([node('A')], [], [running])).toBe(true);
    expect(useGraphStore.getState().activeRuns).toEqual([expect.objectContaining({ id: 'paid-run', status: 'uncertain' })]);
    expect(useGraphStore.getState().canSwitchProject()).toBe(false);
    expect(useGraphStore.getState().loadProjectGraph([node('B')], [], [])).toBe(false);
    expect(useGraphStore.getState().loadProjectGraph([node('B')], [], [history('other', 'running')], { bootstrap: true })).toBe(false);
    expect(useGraphStore.getState().loadProjectGraph([node('Reloaded A')], [], [running], { bootstrap: true })).toBe(true);
    expect(useGraphStore.getState().runHistory[0].status).toBe('running');
    expect(loadRunHistory()[0].status).toBe('running');
    useGraphStore.getState().handleExecutionEvent({ type: 'executionStatus', runId: 'paid-run', status: 'completed' });
    expect(useGraphStore.getState().runHistory[0].status).toBe('complete');
    expect(useGraphStore.getState().canSwitchProject()).toBe(true);
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('refuses switching while a provider submission lacks a trustworthy recovery ID', () => {
    useGraphStore.setState({ providerStartAmbiguities: [{ runId: 'uncertain', nodeId: 'n1',
      kind: 'worldlabs-environment', message: 'Unknown acceptance', durable: true }] });
    expect(useGraphStore.getState().canSwitchProject()).toBe(false);
    expect(useGraphStore.getState().loadProjectGraph([node('B')], [], [])).toBe(false);
  });

  it('ignores stale project graph/recovery echoes before they can merge same-ID nodes', () => {
    setProjectContext({ id: 'B', revision: 'b' });
    useGraphStore.getState().loadProjectGraph([node('B')], [], []);
    transport.sync?.({ type: 'graphSync', workspaceRevision: 'a', graphReplaced: true,
      nodes: [node('Old A')], edges: [], empty: false,
      providerRecoveries: [{ runId: 'old-run', nodeId: 'n1', resumeOperationId: 'old', existingWorldId: null }] } as ExecutionEvent);
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('B');
    expect(useGraphStore.getState().providerRecoveries).toEqual([]);
    transport.sync?.({ type: 'graphSync', workspaceRevision: 'b', nodes: [node('Updated B')], edges: [], empty: false } as ExecutionEvent);
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('Updated B');
  });

  it('keeps delayed terminal outputs and recovery events from a retired project out of same-ID nodes', () => {
    setProjectContext({ id: 'A', revision: 'a' });
    useGraphStore.getState().loadProjectGraph([node('A')], [], [history('run-A')]);
    setProjectContext({ id: 'B', revision: 'b' });
    useGraphStore.getState().loadProjectGraph([node('B')], [], []);
    useGraphStore.getState().handleExecutionEvent({ type: 'executed', runId: 'run-A', nodeId: 'n1',
      outputs: { text: { type: 'Text', value: 'Old A result' } } });
    useGraphStore.getState().handleExecutionEvent({ type: 'providerRecovery', runId: 'run-A', nodeId: 'n1',
      resumeOperationId: 'old-A-job', existingWorldId: null, durable: true, warning: null });
    expect(useGraphStore.getState().nodes[0].data.outputs).toEqual({});
    expect(useGraphStore.getState().providerRecoveries).toEqual([]);
    expect(useGraphStore.getState().runHistory).toEqual([]);
  });

  it('blocks ordinary pending parameter writes and clears their timers on authoritative bootstrap', async () => {
    vi.useFakeTimers();
    useGraphStore.getState().loadProjectGraph([node('A')], [], []);
    useGraphStore.getState().updateNodeData('n1', { params: { value: 'Edited A' } });
    expect(useGraphStore.getState().canSwitchProject()).toBe(false);
    expect(useGraphStore.getState().loadProjectGraph([node('B')], [], [])).toBe(false);
    expect(useGraphStore.getState().loadProjectGraph([node('Authoritative A')], [], [], { bootstrap: true })).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('Authoritative A');
  });

  it('blocks navigation through asynchronous node-create response parsing', async () => {
    useGraphStore.getState().loadProjectGraph([node()], [], []);
    let finish!: (body: unknown) => void;
    transport.fetch.mockResolvedValueOnce({ ...response(), json: () => new Promise((resolve) => { finish = resolve; }) });
    const pending = useGraphStore.getState().addNode('text-input', { x: 360, y: 100 });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(useGraphStore.getState().canSwitchProject()).toBe(false);
    expect(useGraphStore.getState().loadProjectGraph([node('B')], [], [])).toBe(false);
    finish({ id: 'n2' }); expect(await pending).toBe('n2');
    expect(useGraphStore.getState().canSwitchProject()).toBe(true);
  });

  it('keeps a lost node-create acknowledgement locked until its exact committed node syncs', async () => {
    useGraphStore.getState().loadProjectGraph([node()], [], []);
    transport.fetch.mockRejectedValueOnce(new Error('Response lost'))
      .mockResolvedValueOnce(response({ nodes: [] }));
    const position = { x: 360, y: 100 };
    expect(await useGraphStore.getState().addNode('text-input', position)).toBeNull();
    expect(useGraphStore.getState().canSwitchProject()).toBe(false);
    expect(useGraphStore.getState().loadProjectGraph([node('B')], [], [])).toBe(false);
    const committed = { ...node('Committed', 'n2'), position };
    transport.sync?.({ type: 'graphSync', nodes: [node(), committed], edges: [], empty: false });
    expect(useGraphStore.getState().canSwitchProject()).toBe(true);
    expect(transport.fetch.mock.calls.filter(([path]) => path === '/api/graph/node')).toHaveLength(1);
  });

  it('blocks in-flight fire-and-forget layout writes', async () => {
    useGraphStore.getState().loadProjectGraph([node()], [], []);
    let finish!: (body: Response) => void;
    transport.fetch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    useGraphStore.getState().autoLayout();
    expect(useGraphStore.getState().canSwitchProject()).toBe(false);
    finish(response()); await vi.waitFor(() => expect(useGraphStore.getState().canSwitchProject()).toBe(true));
  });

  it('does not resume old Cinema draft PUTs after the backend activates another project', async () => {
    const scene = (prompt: string) => ({ version: 1 as const, base: { model: 'nano-banana' },
      aspectRatio: '16:9' as const, shots: [{ id: 'shot-a', prompt, output: { status: 'idle' as const } }] });
    const old = node('A');
    old.data.definitionId = 'cinema-scene'; old.data.params = { scene: scene('Initial A') };
    useGraphStore.getState().loadProjectGraph([old], [], []);
    useGraphStore.getState().updateScene('n1', scene('Saved A draft'));
    await vi.waitFor(() => expect(useGraphStore.getState().canSwitchProject()).toBe(true));
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(useGraphStore.getState().reserveGraphImport()).toBe(true);
    useGraphStore.getState().releaseGraphImport({ discardSuspended: true });
    setProjectContext({ id: 'B', revision: 'b' });
    expect(useGraphStore.getState().loadProjectGraph([node('B')], [], [])).toBe(true);
    await Promise.resolve();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('B');
  });

  it('waits for active Creator reference uploads before switching without blocking failed drafts', () => {
    useUIStore.setState({ createSessionId: 'upload-session' });
    useCreateDraftStore.getState().getOrCreateDraft('upload-session', { modelId: null, prompt: '',
      params: {}, refs: [], quantity: 1, uploads: [{ id: 'upload', name: 'Reference.png', attempt: 'one', status: 'uploading' }] });
    expect(useGraphStore.getState().canSwitchProject()).toBe(false);
    useCreateDraftStore.getState().updateDraft('upload-session', (draft) => ({
      uploads: draft.uploads.map((upload) => ({ ...upload, status: 'error' as const, error: 'Retry this reference' })),
    }));
    expect(useGraphStore.getState().canSwitchProject()).toBe(true);
  });

  it('does not admit new simple node creation once project replacement owns the graph', async () => {
    useGraphStore.getState().reserveGraphImport();
    expect(await useGraphStore.getState().addNode('text-input', { x: 0, y: 0 })).toBeNull();
    expect(transport.fetch).not.toHaveBeenCalled(); useGraphStore.getState().releaseGraphImport();
  });
});
