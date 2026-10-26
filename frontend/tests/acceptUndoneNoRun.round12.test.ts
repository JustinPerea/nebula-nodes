import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Review 11, L-5 (probe H14): Accept, then Cmd+Z while the accept is on its
// way. The held undo takes the proposal's nodes off when the answer lands;
// the run the accept carried must not be sent then (Nebula refused it, and a
// failed Run history record was left). Its approval goes back instead.

const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string }>,
  accept: null as null | ((value: unknown) => void),
  released: [] as string[],
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async (path: string, init?: RequestInit) => {
    net.calls.push({ path, method: init?.method ?? 'GET' });
    if (path.startsWith('/api/execute')) return new Response(JSON.stringify({ detail: "Node 'n2' not found in graph" }), { status: 404 });
    if (path === '/api/graph/restore') return new Response(JSON.stringify({ status: 'restored', removals: [], notReopened: [], pinsLeft: [] }), { status: 200 });
    return new Response('{}', { status: 200 });
  },
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));
vi.mock('../src/lib/canvasProposals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/canvasProposals')>()),
  acceptProposal: () => new Promise((resolve) => { net.accept = resolve; }),
  releaseApproval: vi.fn(async (id: string) => { net.released.push(id); }),
}));

const { useGraphStore } = await import('../src/store/graphStore');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');
const initialGraph = useGraphStore.getState();
const textNode = (id: string) => ({ id, type: 'model-node', position: { x: 0, y: 0 },
  data: { label: id, definitionId: 'text-input', params: { value: id }, state: 'idle', outputs: {} } }) as unknown as Node<NodeData>;
const settle = () => act(async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); });

function openProposal(): void {
  const view = { id: 'p1', status: 'open', agent: { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true }, note: '', projectId: 'p',
    createdAt: Date.now(), expiresAt: Date.now() + 900000,
    nodes: [{ ref: '+t', definitionId: 'text-input', name: 'Text', category: 'input', params: {}, position: { x: 0, y: 0 },
      cost: { kind: 'free' }, runs: true, willRun: true, ports: { inputs: [], outputs: [] } }],
    edges: [], params: [], run: ['+t'], cost: { paidRuns: 0, freeRuns: 1, estimate: null, upTo: false, providers: [], nodes: [], note: '' },
    references: [], reason: null, idMap: null, runNodeIds: null };
  useCanvasProposalsStore.setState({ proposals: { p1: { view, acceptKey: 'k', values: {} } } as never, pending: {}, errors: {}, drag: {} });
}

describe('Accept undone while it was on its way (review 11, L-5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useGraphStore.setState(initialGraph, true);
    net.calls.length = 0;
    net.released.length = 0;
  });

  it('H14 sends no run and leaves no failed Run history record; the approval goes back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useGraphStore.setState({ nodes: [textNode('n1')], edges: [], undoStack: [], redoStack: [], isExecuting: false,
      providerRecoveries: [], providerStartAmbiguities: [], runHistory: [] } as never);
    openProposal();
    let done: Promise<void> | null = null;
    act(() => { done = useCanvasProposalsStore.getState().accept('p1'); });
    await settle();
    act(() => { useGraphStore.getState().undo(); });
    net.accept!({ nodes: [textNode('n2')], edges: [], updatedNodes: [], runNodeIds: ['n2'], approvalId: 'ap1' });
    await act(async () => { await done; });
    await settle();
    const state = useGraphStore.getState();
    expect(state.nodes.map((node) => node.id)).toEqual(['n1']);
    expect(net.calls.filter((call) => call.path.startsWith('/api/execute'))).toHaveLength(0);
    expect(state.runHistory.filter((record) => record.status === 'failed')).toHaveLength(0);
    expect(net.released).toEqual(['ap1']);
  });

  it('(control) an accept not undone still runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useGraphStore.setState({ nodes: [textNode('n1')], edges: [], undoStack: [], redoStack: [], isExecuting: false,
      providerRecoveries: [], providerStartAmbiguities: [], runHistory: [] } as never);
    openProposal();
    let done: Promise<void> | null = null;
    act(() => { done = useCanvasProposalsStore.getState().accept('p1'); });
    await settle();
    net.accept!({ nodes: [textNode('n2')], edges: [], updatedNodes: [], runNodeIds: ['n2'], approvalId: 'ap1' });
    await act(async () => { await done; });
    await settle();
    expect(net.calls.filter((call) => call.path.startsWith('/api/execute')).length).toBeGreaterThan(0);
  });
});
