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
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { noticeSpy } from './helpers/noticeSpy';

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
  it('replaces same-ID nodes/history and clears undo, editors and stale recovery state, keeping the clipboard', () => {
    setProjectContext({ id: 'A', revision: 'a' });
    useGraphStore.getState().loadProjectGraph([node('A')], [], [history('run-A')]);
    useGraphStore.setState({ nodes: [{ ...node('A'), selected: true }] });
    useGraphStore.getState().copySelected();
    useGraphStore.setState({
      providerRecoveries: [{ runId: 'run-A', nodeId: 'n1', resumeOperationId: 'old-job', existingWorldId: null }] });
    useUIStore.setState({ editorTargetNodeId: 'n1', selectedNodeId: 'n1', selectedClipId: 'clip-A',
      isPlaying: true, renderedPreviewUrl: '/outputs/A.mp4', canvasViewport: { x: 10, y: 20, zoom: 1.3 },
      canvasFocusRequest: { nodeId: 'n1', requestId: 'A-focus' }, createSessionId: 'session-A' });
    setProjectContext({ id: 'B', revision: 'b' });
    expect(useGraphStore.getState().loadProjectGraph([node('B')], [], [history('run-B')])).toBe(true);
    expect(useGraphStore.getState()).toMatchObject({ nodes: [node('B')],
      clipboard: { nodes: [expect.objectContaining({ id: 'n1' })], source: { projectId: 'A' } },
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
    transport.sync?.({ type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, workspaceRevision: 'a', graphReplaced: true,
      nodes: [node('Old A')], edges: [], empty: false,
      providerRecoveries: [{ runId: 'old-run', nodeId: 'n1', resumeOperationId: 'old', existingWorldId: null }] } as ExecutionEvent);
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('B');
    expect(useGraphStore.getState().providerRecoveries).toEqual([]);
    transport.sync?.({ type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, workspaceRevision: 'b', nodes: [node('Updated B')], edges: [], empty: false } as ExecutionEvent);
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
    transport.sync?.({ type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [node(), committed], edges: [], empty: false });
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

function moodboardNode(id = 'n1', board = 'board-in-A'): Node<NodeData> {
  return { id, type: 'nebula-moodboard', position: { x: 40, y: 60 }, selected: true,
    data: { label: 'Moodboard', definitionId: 'nebula-moodboard', params: { moodboard: board }, state: 'complete',
      outputs: { moodboard: { type: 'Moodboard', value: { moodboardId: board } } } } } as Node<NodeData>;
}
function worldNode(id: string, params: Record<string, unknown>): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 }, selected: true,
    data: { label: 'World Labs Environment', definitionId: 'worldlabs-environment', params, state: 'idle', outputs: {} } };
}
function openProject(id: string, nodes: Node<NodeData>[]) {
  setProjectContext({ id, revision: id.toLowerCase() });
  expect(useGraphStore.getState().loadProjectGraph(nodes, [], [])).toBe(true);
}

describe('copy in one project, paste in another (Justin, P2: "copy the node moodboards live in to a different project")', () => {
  it('Cmd+C in A, open B, Cmd+V adds the nodes with params intact and outputs cleared; undo in B removes them', () => {
    openProject('A', [moodboardNode('n1'), { ...node('A', 'n2'), selected: true }]);
    useGraphStore.setState({ edges: [{ id: 'e1', source: 'n1', sourceHandle: 'moodboard', target: 'n2', targetHandle: 'in' }] });
    useGraphStore.getState().copySelected();
    openProject('B', [{ ...node('B', 'n1'), selected: false }]);

    useGraphStore.getState().pasteClipboard();

    const nodes = useGraphStore.getState().nodes;
    expect(nodes).toHaveLength(3);
    const [pastedBoard, pastedText] = nodes.slice(1);
    expect(pastedBoard.data).toMatchObject({ definitionId: 'nebula-moodboard', params: { moodboard: 'board-in-A' },
      state: 'idle', outputs: {} });
    expect(pastedText.data.params).toEqual({ value: 'A' });
    expect(nodes[0].data.params).toEqual({ value: 'B' });
    expect(new Set(nodes.map((n) => n.id)).size).toBe(3);
    expect(useGraphStore.getState().edges).toEqual([expect.objectContaining({ source: pastedBoard.id, target: pastedText.id })]);

    useGraphStore.getState().undo();
    expect(useGraphStore.getState().nodes.map((n) => n.data.params)).toEqual([{ value: 'B' }]);
    expect(useGraphStore.getState().edges).toEqual([]);
  });

  it('a node with a provider-start ambiguity when copied still refuses after the switch, with the same warning', () => {
    const alert = noticeSpy();
    openProject('A', [worldNode('n1', { existing_world_id: 'world-A' })]);
    useGraphStore.setState({ providerStartAmbiguities: [{ runId: 'paid-A', nodeId: 'n1', kind: 'worldlabs-environment',
      message: 'The paid start may have been accepted.', durable: true }] });
    useGraphStore.getState().copySelected();
    // Switching needs the ambiguity settled on A's side; B's lists start empty.
    useGraphStore.setState({ providerStartAmbiguities: [] });
    openProject('B', []);

    useGraphStore.getState().pasteClipboard();

    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('separate paid operation'));
  });

  it("B's checkpoint for its own node with the same id never lands on A's pasted node", () => {
    openProject('A', [worldNode('n1', { existing_world_id: 'world-A' })]);
    useGraphStore.getState().copySelected();
    openProject('B', [{ ...worldNode('n1', { existing_world_id: 'world-B' }), selected: false }]);
    useGraphStore.getState().hydrateProviderRecoveries([{ runId: 'paid-B', nodeId: 'n1', resumeOperationId: 'operation-B',
      existingWorldId: null, durable: true }]);

    useGraphStore.getState().pasteClipboard();

    expect(useGraphStore.getState().nodes.at(-1)!.data.params).toEqual({ existing_world_id: 'world-A' });
  });

  it("A's checkpoint at copy time travels with the node", () => {
    openProject('A', [worldNode('n1', {})]);
    useGraphStore.getState().hydrateProviderRecoveries([{ runId: 'paid-A', nodeId: 'n1', resumeOperationId: 'operation-A',
      existingWorldId: null, durable: true }]);
    useGraphStore.getState().copySelected();
    openProject('B', []);

    useGraphStore.getState().pasteClipboard();

    expect(useGraphStore.getState().nodes.map((n) => n.data.params)).toEqual([{ resume_operation_id: 'operation-A' }]);
  });

  it('a blank paid World Labs node is never cloned into a new paid start, here or after a switch', () => {
    const alert = noticeSpy();
    openProject('A', [worldNode('n1', {})]);
    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();
    openProject('B', []);
    useGraphStore.getState().pasteClipboard();
    expect(useGraphStore.getState().nodes).toEqual([]);
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('pasting back into A after a round trip uses the copy-time params; pasting where it was copied re-checks as before', () => {
    openProject('A', [{ ...node('A', 'n1'), selected: true }]);
    useGraphStore.getState().copySelected();
    useGraphStore.getState().pasteClipboard();
    expect(useGraphStore.getState().nodes).toHaveLength(2);
    openProject('B', []);
    openProject('A', [node('A', 'n1')]);
    useGraphStore.getState().pasteClipboard();
    expect(useGraphStore.getState().nodes.map((n) => n.data.params)).toEqual([{ value: 'A' }, { value: 'A' }]);
  });

  it('a paste from another project lands at the middle of the view, clear of what is there, keeping its layout', () => {
    const board = { ...moodboardNode('n1'), position: { x: 0, y: 0 }, measured: { width: 300, height: 420 } };
    const text = { ...node('A', 'n2'), selected: true, position: { x: 360, y: 60 }, measured: { width: 280, height: 160 } };
    openProject('A', [board, text]);
    useGraphStore.getState().copySelected();
    // B already has a node exactly where A's were, and one in the middle of the view.
    const there = { ...node('B', 'n1'), selected: false, position: { x: 0, y: 0 }, measured: { width: 300, height: 420 } };
    const middle = { ...node('B2', 'n2'), selected: false, position: { x: 900, y: 450 }, measured: { width: 300, height: 300 } };
    openProject('B', [there, middle]);

    useGraphStore.getState().pasteClipboard({ view: { x: -200, y: -100, width: 2400, height: 1400 } });

    const [pastedBoard, pastedText] = useGraphStore.getState().nodes.slice(2);
    expect({ dx: pastedText.position.x - pastedBoard.position.x, dy: pastedText.position.y - pastedBoard.position.y })
      .toEqual({ dx: 360, dy: 60 });
    const box = { x: pastedBoard.position.x, y: pastedBoard.position.y, width: 640, height: 420 };
    for (const existing of [there, middle]) {
      const r = { ...existing.position, ...existing.measured! };
      expect(box.x < r.x + r.width && r.x < box.x + box.width && box.y < r.y + r.height && r.y < box.y + box.height).toBe(false);
    }
    // In the view (-200..2200 x -100..1300), though its middle is taken.
    expect(box.x >= -200 && box.y >= -100 && box.x + box.width <= 2200 && box.y + box.height <= 1300).toBe(true);
  });

  it('a paste from another project with a free view centre sits right on it', () => {
    openProject('A', [{ ...moodboardNode('n1'), position: { x: 5000, y: 5000 }, measured: { width: 300, height: 400 } }]);
    useGraphStore.getState().copySelected();
    openProject('B', [{ ...node('B', 'n1'), selected: false, position: { x: 0, y: 0 }, measured: { width: 300, height: 200 } }]);
    useGraphStore.getState().pasteClipboard({ view: { x: -1800, y: 1500, width: 1600, height: 1000 } });
    expect(useGraphStore.getState().nodes[1].position).toEqual({ x: -1150, y: 1800 });
  });

  it('a paste on the canvas it was copied from is still +20 px, whatever the view', () => {
    openProject('A', [{ ...node('A', 'n1'), selected: true, position: { x: 100, y: 200 } }]);
    useGraphStore.getState().copySelected();
    const pasted = useGraphStore.getState().pasteClipboard({ view: { x: 8200, y: 8500, width: 1600, height: 1000 } });
    expect(useGraphStore.getState().nodes.map((n) => n.position)).toEqual([{ x: 100, y: 200 }, { x: 120, y: 220 }]);
    expect(pasted).toEqual([useGraphStore.getState().nodes[1].id]);
  });
});

