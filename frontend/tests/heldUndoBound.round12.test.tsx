import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Review 11, M-1, L-2, L-3, L-4 and L-6 (probes H1-H13 and the live S1).
// A Cmd+Z pressed while a step's request is on its way is bound to that
// step. When the step settles it undoes that step (or a delete's re-pushed
// successor of it), never whatever else landed on top meanwhile: then it is
// dropped, and GM - Design's notice says so (round 12, addendum a). A clear
// changes only the nodes it sent, never ones that arrived after it. An upload
// settles only once its node is on the canvas. The 15 s limit drops a held
// press, never applies it late. A project switch drops the old project's
// presses.

type Answer = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body?: string }>,
  held: new Map<string, (answer: Answer) => void>(),
  holdDeletes: true,
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    net.calls.push({ path, method, body: typeof init?.body === 'string' ? init.body : undefined });
    const deleted = /^\/api\/graph\/node\/(n\d+)$/.exec(path);
    if (deleted && method === 'DELETE') {
      const answer = net.holdDeletes
        ? await new Promise<Answer>((resolve) => { net.held.set(deleted[1], resolve); })
        : { status: 200, body: { status: 'deleted', id: deleted[1] } };
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    if (path === '/api/graph/restore') {
      return new Response(JSON.stringify({ status: 'restored', reattached: [], reopened: [], notReopened: [], pinsLeft: [], removals: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  },
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';
import { DROPPED_UNDO_TEXT } from '../src/lib/deleteNotice';

const initialGraph = useGraphStore.getState();
function textNode(id: string, value = id): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 100, y: 100 }, width: 120, height: 60,
    data: { label: value, definitionId: 'text-input', params: { value }, state: 'idle', outputs: {} } } as Node<NodeData>;
}
function wire(source: string, target: string): Edge {
  return { id: `e-${source}-${target}`, source, sourceHandle: 'text', target, targetHandle: 'prompt', type: 'typed-edge' };
}
const store = () => useGraphStore.getState();
const graph = () => ({
  nodes: store().nodes.map((node) => node.id).sort(),
  edges: store().edges.map((edge) => edge.id).sort(),
});
const valueOf = (id: string) => store().nodes.find((node) => node.id === id)?.data.params.value;
const stacks = () => ({ undo: store().undoStack.length, redo: store().redoStack.length });
/** Whether GM's dropped-undo line shows, in either notice place. */
const dropped = () => store().undoNotice?.text === DROPPED_UNDO_TEXT || store().messageNotice?.text === DROPPED_UNDO_TEXT;
const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); });
const undo = async () => { act(() => { store().undo(); }); await settle(); };
const redo = async () => { act(() => { store().redo(); }); await settle(); };
const answer = async (id: string, status = 200) => {
  const resolve = net.held.get(id);
  if (!resolve) throw new Error(`no delete of ${id} on its way`);
  net.held.delete(id);
  await act(async () => {
    resolve(status === 200 ? { status, body: { status: 'deleted', id } } : { status, body: { detail: 'It is running.' } });
  });
  await settle();
};
const restores = () => net.calls.filter((call) => call.method === 'POST' && call.path === '/api/graph/restore')
  .map((call) => JSON.parse(call.body ?? '{}') as { nodes: Array<{ id: string }>; remove: string[] });
const emit = (event: Record<string, unknown>) => {
  const full = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, edges: [], ...event } as unknown as ExecutionEvent;
  act(() => { for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(full); });
};
/** This tab's own echo. */
const ownSync = (nodes: Node<NodeData>[], edges: Edge[] = []) => emit({ nodes, edges, empty: nodes.length === 0,
  edit: { actor: { kind: 'person' }, tab: TAB_ID, id: 'ed_own' } });
/** An agent's edit: one foreign step. */
const agentSync = (nodes: Node<NodeData>[], edges: Edge[] = []) => emit({ nodes, edges, empty: nodes.length === 0,
  edit: { actor: { kind: 'agent', name: 'Codex', color: '#ff00aa' }, id: 'ed_agent' } });
/** Another project opened. */
const projectSwitch = (nodes: Node<NodeData>[]) => emit({ nodes, empty: nodes.length === 0, graphReplaced: true });

describe('a held Cmd+Z is bound to the step it was pressed for (review 11, M-1)', () => {
  beforeEach(() => {
    net.calls.length = 0;
    net.held.clear();
    net.holdDeletes = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    useGraphStore.setState(initialGraph, true);
  });
  const setGraph = (nodes: Node<NodeData>[], edges: Edge[] = []) => useGraphStore.setState({ nodes, edges, isExecuting: false,
    undoStack: [], redoStack: [], undoNotice: null, messageNotice: null, providerRecoveries: [], providerStartAmbiguities: [] } as never);

  it("GM's words, verbatim (round 12, addendum a)", () => {
    expect(DROPPED_UNDO_TEXT).toBe('Nothing was undone. Your last change was still saving.');
  });

  it('H1 (control) a delete whose answer lands after an agent edit: its re-pushed step is undone, the agent node stays', async () => {
    setGraph([textNode('n1'), textNode('n2')], [wire('n1', 'n2')]);
    act(() => { store().deleteNode('n2'); });
    await settle();
    await undo();
    agentSync([textNode('n1'), textNode('n2'), textNode('n3')], [wire('n1', 'n2')]);
    await answer('n2');
    expect(graph()).toEqual({ nodes: ['n1', 'n2', 'n3'], edges: ['e-n1-n2'] });
    expect(dropped()).toBe(false);
    expect(restores()).toHaveLength(1);
  });

  it("H2 an upload: an agent edit lands before the answer, so the press is dropped and Codex's edit stays", async () => {
    setGraph([textNode('n1')]);
    const step = store().beginUndoStep();
    act(() => { store().undo(); });
    agentSync([textNode('n1'), textNode('n7')]);
    ownSync([textNode('n1'), textNode('n7'), textNode('n2')]);
    act(() => { store().endUndoStep(step, { arrives: ['n2'] }); });
    await settle();
    expect(graph().nodes).toEqual(['n1', 'n2', 'n7']);
    expect(stacks()).toEqual({ undo: 2, redo: 0 });
    expect(restores()).toHaveLength(0);
    expect(dropped()).toBe(true);
    // Two presses now: Codex's edit, then the upload.
    await undo();
    await undo();
    expect(graph().nodes).toEqual(['n1']);
  });

  it('H3 Clear canvas: own echo, then an agent adds a node, then the answer: the agent node stays, the press is dropped', async () => {
    setGraph([textNode('n1'), textNode('n2')], [wire('n1', 'n2')]);
    const step = store().beginUndoStep();
    act(() => { store().undo(); });
    ownSync([]);
    agentSync([textNode('n5')]);
    act(() => { store().clearGraph({ undoStep: step }); });
    act(() => { store().endUndoStep(step); });
    await settle();
    expect(graph().nodes).toEqual(['n5']);
    expect(stacks()).toEqual({ undo: 2, redo: 0 });
    expect(dropped()).toBe(true);
  });

  it('S1 (live) Clear canvas with Codex adding n1 mid-clear: nothing lost, two presses bring the canvas back', async () => {
    setGraph([textNode('n1', 'Hero prompt'), textNode('n2', 'Second prompt')], [wire('n1', 'n2')]);
    const step = store().beginUndoStep();
    ownSync([]);
    act(() => { store().undo(); });
    // Ids restart after a clear: the agent's node is n1 too.
    agentSync([textNode('n1', 'Agent node')]);
    act(() => { store().clearGraph({ undoStep: step }); });
    act(() => { store().endUndoStep(step); });
    await settle();
    expect(graph().nodes).toEqual(['n1']);
    expect(valueOf('n1')).toBe('Agent node');
    expect(stacks()).toEqual({ undo: 2, redo: 0 });
    expect(dropped()).toBe(true);
    await undo();
    expect(graph().nodes).toEqual([]);
    await undo();
    expect(graph()).toEqual({ nodes: ['n1', 'n2'], edges: ['e-n1-n2'] });
    expect(valueOf('n1')).toBe('Hero prompt');
    expect(stacks()).toEqual({ undo: 0, redo: 2 });
  });

  it("S1, answer first: the clear's answer before its echo still empties the canvas and is undone by the held press", async () => {
    setGraph([textNode('n1', 'Hero prompt'), textNode('local', 'Local')]);
    const step = store().beginUndoStep();
    act(() => { store().undo(); });
    act(() => { store().clearGraph({ undoStep: step }); });
    act(() => { store().endUndoStep(step); });
    await settle();
    expect(graph().nodes).toEqual(['local', 'n1']);
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
    expect(dropped()).toBe(false);
  });

  it('H5 the person types after the press, before the delete answers: the delete (re-pushed) is undone, the typing stays', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().deleteNode('n2'); });
    await settle();
    await undo();
    act(() => { store().updateNodeData('n1', { params: { value: 'Typed' } }); });
    await answer('n2');
    expect(graph().nodes).toEqual(['n1', 'n2']);
    expect(valueOf('n1')).toBe('Typed');
  });

  it('H6 a project switch drops the old project\'s press, and a press in the new project never waits for the old delete', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().deleteNode('n2'); });
    await settle();
    await undo();
    projectSwitch([textNode('n1')]);
    expect(dropped()).toBe(true);
    act(() => { store().updateNodeData('n1', { params: { value: 'NewProjectEdit' } }); });
    await undo();
    // Applied at once, not queued behind the old project's delete.
    expect(valueOf('n1')).toBe('n1');
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
    await answer('n2');
    expect(valueOf('n1')).toBe('n1');
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
    expect(restores().some((body) => body.nodes.some((node) => node.id === 'n2'))).toBe(false);
  });

  it('H7 (L-2) an upload whose answer lands before its echo: the press waits for the node, then undoes it; Redo puts it back', async () => {
    setGraph([textNode('n1')]);
    const step = store().beginUndoStep();
    act(() => { store().undo(); });
    act(() => { store().endUndoStep(step, { arrives: ['n2'] }); });
    await settle();
    expect(stacks()).toEqual({ undo: 1, redo: 0 });
    ownSync([textNode('n1'), textNode('n2')]);
    await settle();
    expect(graph().nodes).toEqual(['n1']);
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
    expect(restores().at(-1)?.remove).toEqual(['n2']);
    net.calls.length = 0;
    await redo();
    expect(graph().nodes).toEqual(['n1', 'n2']);
    expect(restores().at(-1)?.nodes.map((node) => node.id)).toEqual(['n2']);
  });

  it('H8 a model configure: an agent edit lands before the answer, so the press is dropped', async () => {
    setGraph([textNode('n1')]);
    const step = store().beginUndoStep();
    act(() => { store().undo(); });
    agentSync([textNode('n1'), textNode('n9')]);
    act(() => { useGraphStore.setState((s) => ({ nodes: s.nodes.map((n) => n.id === 'n1' ? { ...n, data: { ...n.data, params: { value: 'model-B' } } } : n) })); });
    act(() => { store().endUndoStep(step); });
    await settle();
    expect(graph().nodes).toEqual(['n1', 'n9']);
    expect(valueOf('n1')).toBe('model-B');
    expect(stacks()).toEqual({ undo: 2, redo: 0 });
    expect(restores()).toHaveLength(0);
    expect(dropped()).toBe(true);
  });

  it('H9 an accept: own echo, then an agent edit, then the answer: the press is dropped, no stray redo', async () => {
    setGraph([textNode('n1')]);
    const step = store().beginUndoStep();
    act(() => { store().undo(); });
    ownSync([textNode('n1'), textNode('n2')]);
    agentSync([textNode('n1'), textNode('n2'), textNode('n8')]);
    act(() => { store().adoptAcceptedProposal({ nodes: [textNode('n2')], edges: [], updatedNodes: [] } as never, { undoStep: step, synced: new Set(['n2']) }); });
    act(() => { store().endUndoStep(step); });
    await settle();
    expect(graph().nodes).toEqual(['n1', 'n2', 'n8']);
    expect(stacks()).toEqual({ undo: 2, redo: 0 });
    expect(restores()).toHaveLength(0);
    expect(dropped()).toBe(true);
  });

  it('H10 (L-3) the 15 s limit drops the press; the late answer deletes as usual, and the next press undoes it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setGraph([textNode('n1'), textNode('n2')], [wire('n1', 'n2')]);
    act(() => { store().deleteNode('n2'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    act(() => { store().undo(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_010); });
    expect(dropped()).toBe(true);
    expect(graph()).toEqual({ nodes: ['n1', 'n2'], edges: ['e-n1-n2'] });
    expect(stacks()).toEqual({ undo: 1, redo: 0 });
    const resolve = net.held.get('n2')!;
    net.held.delete('n2');
    await act(async () => { resolve({ status: 200, body: { status: 'deleted', id: 'n2' } }); await vi.advanceTimersByTimeAsync(50); });
    expect(graph().nodes).toEqual(['n1']);
    expect(stacks()).toEqual({ undo: 1, redo: 0 });
    net.holdDeletes = false;
    act(() => { store().undo(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(graph()).toEqual({ nodes: ['n1', 'n2'], edges: ['e-n1-n2'] });
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
  });

  it('H11 (L-3) the echo is in, the limit drops the press: the canvas and Nebula agree, no restore, no stray redo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setGraph([textNode('n1'), textNode('n2')], [wire('n1', 'n2')]);
    act(() => { store().deleteNode('n2'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    ownSync([textNode('n1')]);
    act(() => { store().undo(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_010); });
    expect(dropped()).toBe(true);
    expect(graph().nodes).toEqual(['n1']);
    expect(restores()).toHaveLength(0);
    const resolve = net.held.get('n2')!;
    net.held.delete('n2');
    await act(async () => { resolve({ status: 200, body: { status: 'deleted', id: 'n2' } }); await vi.advanceTimersByTimeAsync(50); });
    expect(graph().nodes).toEqual(['n1']);
    expect(stacks()).toEqual({ undo: 1, redo: 0 });
    expect(restores()).toHaveLength(0);
  });

  it('H12 (L-3) refused after the limit: the earlier edit stays, no no-op redo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().updateNodeData('n1', { params: { value: 'Edited' } }); });
    act(() => { store().deleteNode('n2'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    act(() => { store().undo(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_010); });
    expect(dropped()).toBe(true);
    expect(valueOf('n1')).toBe('Edited');
    const resolve = net.held.get('n2')!;
    net.held.delete('n2');
    await act(async () => { resolve({ status: 409, body: { detail: 'It is running.' } }); await vi.advanceTimersByTimeAsync(50); });
    expect(graph().nodes).toEqual(['n1', 'n2']);
    expect(valueOf('n1')).toBe('Edited');
    expect(stacks()).toEqual({ undo: 1, redo: 0 });
  });

  it('H13 (L-6) chat /clear: a node an agent adds in the gap (ids restart at n1) stays on the canvas', async () => {
    setGraph([textNode('n1'), textNode('n2'), textNode('local')]);
    const step = store().beginUndoStep();
    ownSync([]);
    agentSync([textNode('n1', 'Agent node')]);
    act(() => { store().clearBackendNodes({ undoStep: step }); });
    act(() => { store().endUndoStep(step); });
    await settle();
    expect(graph().nodes).toEqual(['local', 'n1']);
    expect(valueOf('n1')).toBe('Agent node');
    expect(stacks()).toEqual({ undo: 2, redo: 0 });
  });

  it('a clear answered before its echo removes only what it sent: a node the person added meanwhile stays', async () => {
    setGraph([textNode('n1'), textNode('local')]);
    const step = store().beginUndoStep();
    act(() => { useGraphStore.setState((s) => ({ nodes: [...s.nodes, textNode('later', 'Later')] })); });
    act(() => { store().clearGraph({ undoStep: step }); });
    act(() => { store().endUndoStep(step); });
    expect(graph().nodes).toEqual(['later']);
  });

  it('a delete whose echo landed, then an agent edit, then the answer: no empty step, the press is dropped', async () => {
    setGraph([textNode('n1'), textNode('n2')]);
    act(() => { store().deleteNode('n2'); });
    await settle();
    ownSync([textNode('n1')]);
    await undo();
    agentSync([textNode('n1'), textNode('n4')]);
    await answer('n2');
    expect(graph().nodes).toEqual(['n1', 'n4']);
    expect(stacks()).toEqual({ undo: 2, redo: 0 });
    expect(dropped()).toBe(true);
    expect(restores()).toHaveLength(0);
  });
});

describe('every upload step waits for its node (review 11, L-2)', () => {
  it.each([
    ['components/panels/ChatPanel.tsx'],
    ['lib/canvasFileDrop.ts'],
  ])('%s ends its upload step with the node id the answer names', async (path) => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const text = readFileSync(join(__dirname, '..', 'src', path), 'utf8');
    expect(text).toMatch(/arrives = \[body\.nodeId\]/);
    expect(text).toMatch(/endUndoStep\(undoStep, \{ arrives \}\)/);
  });
});
