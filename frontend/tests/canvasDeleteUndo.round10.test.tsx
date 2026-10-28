import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider, type Edge, type Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Review 9, L-4 (live LF): one Delete became two undo steps. The canvas's
// Delete went through React Flow's deleteElements, which removes the wires
// (onEdgesChange, one step) and then the nodes (onNodesChange, another), so
// the first Cmd+Z put the node back without its wire. One delete is one undo
// step that puts back the nodes and their wires together, on every delete
// path: the key, the selection toolbar, the context menu, the Inspector, and
// an agent's remove_from_canvas.

const net = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string }> }));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    net.calls.push({ path, method });
    const deleted = /^\/api\/graph\/node\/(n\d+)$/.exec(path);
    if (deleted && method === 'DELETE') {
      return new Response(JSON.stringify({ status: 'deleted', id: deleted[1] }), { status: 200 });
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
const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); });
const undo = async () => {
  act(() => { useGraphStore.getState().undo(); });
  await settle();
};

describe('one delete is one undo step, wires included', () => {
  beforeEach(() => {
    net.calls.length = 0;
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
  const press = async (key: string) => {
    act(() => { fireEvent.keyDown(document.body, { key, code: key }); });
    await settle();
    act(() => { fireEvent.keyUp(document.body, { key, code: key }); });
  };

  it.each([
    ['canvas-only nodes', 'a', 'b'],
    ["nodes Nebula's backend knows (sent as deletes)", 'n1', 'n2'],
  ])('the Delete key, %s: one Cmd+Z puts back the node and its wire', async (_name, a, b) => {
    setGraph([textNode(a), textNode(b, true)], [wire(a, b)]);
    renderCanvas();
    await press('Delete');
    expect(graph()).toEqual({ nodes: [a], edges: [] });
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
    expect(useGraphStore.getState().undoNotice?.text).toBe('Deleted the node.');
    await undo();
    expect(graph()).toEqual({ nodes: [a, b].sort(), edges: [`e-${a}-${b}`] });
  });

  it('Backspace on a node and a separate selected wire: one step for both', async () => {
    setGraph([textNode('a'), textNode('b', true), textNode('c'), textNode('d')], [wire('a', 'b'), wire('c', 'd', true)]);
    renderCanvas();
    await press('Backspace');
    expect(graph()).toEqual({ nodes: ['a', 'c', 'd'], edges: [] });
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
    await undo();
    expect(graph()).toEqual({ nodes: ['a', 'b', 'c', 'd'], edges: ['e-a-b', 'e-c-d'] });
  });

  it('a wire alone is one step too', async () => {
    setGraph([textNode('a'), textNode('b')], [wire('a', 'b', true)]);
    renderCanvas();
    await press('Delete');
    expect(graph().edges).toEqual([]);
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
    await undo();
    expect(graph().edges).toEqual(['e-a-b']);
  });

  it.each([
    ['the selection toolbar (deleteSelected)', () => useGraphStore.getState().deleteSelected()],
    ['the context menu and the Inspector (deleteNode)', () => useGraphStore.getState().deleteNode('b')],
  ])('%s: one step, the wire comes back with the node', async (_name, remove) => {
    setGraph([textNode('a'), textNode('b', true)], [wire('a', 'b')]);
    act(() => { remove(); });
    await settle();
    expect(graph()).toEqual({ nodes: ['a'], edges: [] });
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
    await undo();
    expect(graph()).toEqual({ nodes: ['a', 'b'], edges: ['e-a-b'] });
  });

  it("an agent's remove_from_canvas (one graphSync): one step, the wire comes back with the node", async () => {
    setGraph([textNode('n1'), textNode('n2')], [wire('n1', 'n2')]);
    const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: [textNode('n1')], edges: [], empty: false,
      edit: { actor: { kind: 'agent', id: 'claude', name: 'Claude', color: '#d97757' }, id: 'ed_0123456789abcdef' } } as unknown as ExecutionEvent;
    act(() => { for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event); });
    await settle();
    expect(graph()).toEqual({ nodes: ['n1'], edges: [] });
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
    await undo();
    expect(graph()).toEqual({ nodes: ['n1', 'n2'], edges: ['e-n1-n2'] });
  });
});
