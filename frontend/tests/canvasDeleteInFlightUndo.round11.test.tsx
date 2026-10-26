import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider, type Edge, type Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Review 10, L-2 (probe D4): Cmd+Z while the backend delete was on its way
// was lost. Undo took the step off before the node was gone (it undid
// nothing), then the backend's answer deleted the node anyway and took a new
// step: node gone, one step on the stack, a redo that did nothing, no
// "Deleted the node." An undo pressed while a step's request is on its way
// now waits for the answer and then undoes that step: the node and its wires
// come back, here and on the backend (a restore after the delete), with no
// extra step and no stray redo. Every delete path, and every other step taken
// before a backend request (beginUndoStep), waits the same way.

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
vi.mock('../src/components/SelectionToolbar', () => ({ SelectionToolbar: () => null }));
vi.mock('../src/components/CanvasNavigation', () => ({ CanvasNavigation: () => null }));
vi.mock('../src/components/canvas/CanvasViewReporter', () => ({ CanvasViewReporter: () => null }));
vi.mock('../src/components/canvas/ArrangeController', () => ({ ArrangeController: () => null }));
vi.mock('../src/components/canvas/AgentCursorLayer', () => ({ AgentCursorLayer: () => null }));
vi.mock('../src/components/canvas/PinLayer', () => ({ PinLayer: () => null }));
vi.mock('../src/components/canvas/PinComposer', () => ({ PinComposer: () => null }));
vi.mock('../src/components/canvas/ProposalLayer', () => ({ ProposalLayer: () => null }));
vi.mock('../src/components/canvas/ProposalBar', () => ({ ProposalBar: () => null }));
vi.mock('../src/components/ContextMenu', () => ({ ContextMenu: () => null }));
vi.mock('../src/components/ConnectionPopup', () => ({ ConnectionPopup: () => null }));
vi.mock('../src/lib/canvasSelection', () => ({
  selectedNodeIds: (nodes: Node<NodeData>[]) => nodes.filter((node) => node.selected).map((node) => node.id),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { Canvas } from '../src/components/Canvas';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
function textNode(id: string, selected = false): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 100, y: 100 }, selected, width: 120, height: 60,
    data: { label: id, definitionId: 'text-input', params: { value: id }, state: 'idle', outputs: {} } } as Node<NodeData>;
}
function wire(source: string, target: string, selected = false): Edge {
  return { id: `e-${source}-${target}`, source, sourceHandle: 'text', target, targetHandle: 'prompt', type: 'typed-edge', selected };
}
const graph = () => ({
  nodes: useGraphStore.getState().nodes.map((node) => node.id).sort(),
  edges: useGraphStore.getState().edges.map((edge) => edge.id).sort(),
});
const stacks = () => ({ undo: useGraphStore.getState().undoStack.length, redo: useGraphStore.getState().redoStack.length });
const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); });
const undo = async () => { act(() => { useGraphStore.getState().undo(); }); await settle(); };
const redo = async () => { act(() => { useGraphStore.getState().redo(); }); await settle(); };
const answer = async (id: string, status = 200) => {
  const resolve = net.held.get(id);
  if (!resolve) throw new Error(`no delete of ${id} on its way`);
  net.held.delete(id);
  await act(async () => {
    resolve(status === 200 ? { status, body: { status: 'deleted', id } } : { status, body: { detail: 'It is running.' } });
  });
  await settle();
};
const sent = (method: string, path: string) => net.calls.filter((call) => call.method === method && call.path === path);
const sync = (nodes: Node<NodeData>[], edges: Edge[]) => {
  const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes, edges, empty: nodes.length === 0,
    edit: { actor: { kind: 'person' }, tab: TAB_ID, id: 'ed_own' } } as unknown as ExecutionEvent;
  act(() => { for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event); });
};

describe('Cmd+Z while a delete is on its way', () => {
  beforeEach(() => {
    net.calls.length = 0;
    net.held.clear();
    net.holdDeletes = true;
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useUIStore.setState({ ...initialUI, viewMode: 'canvas' }, true);
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useUIStore.setState(initialUI, true);
    useGraphStore.setState(initialGraph, true);
  });

  const setGraph = (nodes: Node<NodeData>[], edges: Edge[]) => useGraphStore.setState({ nodes, edges, isExecuting: false,
    undoStack: [], redoStack: [], undoNotice: null, messageNotice: null, providerRecoveries: [], providerStartAmbiguities: [] } as never);
  const renderCanvas = () => render(<div style={{ width: 1280, height: 800 }}><ReactFlowProvider><Canvas /></ReactFlowProvider></div>);
  const pressDelete = async () => {
    act(() => { fireEvent.keyDown(document.body, { key: 'Delete', code: 'Delete' }); });
    act(() => { fireEvent.keyUp(document.body, { key: 'Delete', code: 'Delete' }); });
    await settle();
  };

  it('the Delete key (probe D4): the node and its wire come back, one step undone, Redo deletes again', async () => {
    setGraph([textNode('n1'), textNode('n2', true)], [wire('n1', 'n2')]);
    renderCanvas();
    await pressDelete();
    expect(net.held.has('n2')).toBe(true);
    await undo();
    // Still on its way: nothing changed yet.
    expect(graph()).toEqual({ nodes: ['n1', 'n2'], edges: ['e-n1-n2'] });
    await answer('n2');
    expect(graph()).toEqual({ nodes: ['n1', 'n2'], edges: ['e-n1-n2'] });
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
    expect(useGraphStore.getState().undoNotice?.text).toBe('Restored the node.');
    // The backend got the node and its wire back after the delete: no orphan.
    const restores = sent('POST', '/api/graph/restore');
    expect(restores).toHaveLength(1);
    const body = JSON.parse(restores[0].body!) as { nodes: Array<{ id: string }>; wire: unknown[] };
    expect(body.nodes.map((node) => node.id)).toEqual(['n2']);
    expect(body.wire).toHaveLength(1);
    // And Redo is the delete again, not an empty step.
    net.holdDeletes = false;
    await redo();
    expect(graph()).toEqual({ nodes: ['n1'], edges: [] });
    expect(stacks()).toEqual({ undo: 1, redo: 0 });
  });

  it("its own graphSync landing first changes nothing: the undo still waits for the answer", async () => {
    setGraph([textNode('n1'), textNode('n2', true)], [wire('n1', 'n2')]);
    renderCanvas();
    await pressDelete();
    sync([textNode('n1')], []);
    await settle();
    await undo();
    await answer('n2');
    expect(graph()).toEqual({ nodes: ['n1', 'n2'], edges: ['e-n1-n2'] });
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
    expect(sent('POST', '/api/graph/restore')).toHaveLength(1);
  });

  it('a refused delete: the undo aimed at it undoes nothing else (the step before stays)', async () => {
    setGraph([textNode('n1'), textNode('n2', true)], [wire('n1', 'n2')]);
    renderCanvas();
    // An earlier step of the person's: an edit.
    act(() => { useGraphStore.getState().updateNodeData('n1', { params: { value: 'Edited' } }); });
    expect(stacks().undo).toBe(1);
    await pressDelete();
    await undo();
    await answer('n2', 409);
    expect(graph()).toEqual({ nodes: ['n1', 'n2'], edges: ['e-n1-n2'] });
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n1')?.data.params.value).toBe('Edited');
    expect(stacks()).toEqual({ undo: 1, redo: 0 });
    expect(sent('POST', '/api/graph/restore')).toHaveLength(0);
  });

  it('a refused delete with a separate selected wire: the wire comes back (the step held it)', async () => {
    setGraph([textNode('n1'), textNode('n2', true), textNode('n3'), textNode('n4')], [wire('n1', 'n2'), wire('n3', 'n4', true)]);
    renderCanvas();
    await pressDelete();
    expect(graph().edges).toEqual(['e-n1-n2']);
    await undo();
    await answer('n2', 409);
    expect(graph()).toEqual({ nodes: ['n1', 'n2', 'n3', 'n4'], edges: ['e-n1-n2', 'e-n3-n4'] });
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
  });

  it('two presses while it is on its way: the delete, then the step before it, in order', async () => {
    setGraph([textNode('n1'), textNode('n2', true)], [wire('n1', 'n2')]);
    renderCanvas();
    act(() => { useGraphStore.getState().updateNodeData('n1', { params: { value: 'Edited' } }); });
    await pressDelete();
    await undo();
    await undo();
    await answer('n2');
    expect(graph()).toEqual({ nodes: ['n1', 'n2'], edges: ['e-n1-n2'] });
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n1')?.data.params.value).toBe('n1');
    expect(stacks()).toEqual({ undo: 0, redo: 2 });
  });

  it.each([
    ['the selection toolbar (deleteSelected)', () => useGraphStore.getState().deleteSelected()],
    ['the context menu and the Inspector (deleteNode)', () => useGraphStore.getState().deleteNode('n2')],
    ['a generation (deleteGeneration)', () => useGraphStore.getState().deleteGeneration(['n2'])],
    ['deleteCanvasElements', () => useGraphStore.getState().deleteCanvasElements(['n2'], [])],
  ])('%s: the same', async (_name, remove) => {
    setGraph([textNode('n1'), textNode('n2', true)], [wire('n1', 'n2')]);
    act(() => { remove(); });
    await settle();
    await undo();
    // A generation's delete takes the text input feeding only it, too (n1).
    for (const id of [...net.held.keys()]) await answer(id);
    expect(graph()).toEqual({ nodes: ['n1', 'n2'], edges: ['e-n1-n2'] });
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
    expect(sent('POST', '/api/graph/restore')).toHaveLength(1);
  });

  it('a step taken before any backend request (beginUndoStep) waits the same way: Clear canvas', () => {
    setGraph([textNode('n1'), textNode('n2')], [wire('n1', 'n2')]);
    const store = () => useGraphStore.getState();
    const step = store().beginUndoStep();
    act(() => { store().undo(); });
    // The clear's answer: the canvas is cleared under the step, then the step ends.
    act(() => { store().clearGraph({ undoStep: step }); });
    act(() => { store().endUndoStep(step); });
    expect(graph()).toEqual({ nodes: ['n1', 'n2'], edges: ['e-n1-n2'] });
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
  });

  it('a step whose request failed (cancelUndoStep) lets a waiting undo go to nothing', () => {
    setGraph([textNode('a')], []);
    const store = () => useGraphStore.getState();
    act(() => { store().updateNodeData('a', { params: { value: 'Edited' } }); });
    const step = store().beginUndoStep();
    act(() => { store().undo(); });
    act(() => { store().cancelUndoStep(step); });
    expect(useGraphStore.getState().nodes[0].data.params.value).toBe('Edited');
    expect(stacks()).toEqual({ undo: 1, redo: 0 });
  });

  it('/clear in the chat: its canvas side lands with the answer, so a waiting undo brings the nodes back', () => {
    setGraph([textNode('n1'), textNode('n2'), textNode('local')], [wire('n1', 'n2')]);
    const store = () => useGraphStore.getState();
    const step = store().beginUndoStep();
    act(() => { store().undo(); });
    act(() => { store().clearBackendNodes({ undoStep: step }); });
    act(() => { store().endUndoStep(step); });
    expect(graph()).toEqual({ nodes: ['local', 'n1', 'n2'], edges: ['e-n1-n2'] });
    expect(stacks()).toEqual({ undo: 0, redo: 1 });
  });

  it('clearBackendNodes keeps the nodes only this tab has, under the step it was given', () => {
    setGraph([textNode('n1'), textNode('n2'), textNode('local')], [wire('n1', 'n2')]);
    const store = () => useGraphStore.getState();
    const step = store().beginUndoStep();
    act(() => { store().clearBackendNodes({ undoStep: step }); });
    act(() => { store().endUndoStep(step); });
    expect(graph()).toEqual({ nodes: ['local'], edges: [] });
    expect(stacks()).toEqual({ undo: 1, redo: 0 });
  });
});
