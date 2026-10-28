import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProposalView } from '../src/lib/wsClient';

const ws = vi.hoisted(() => ({ handlers: [] as Array<(event: unknown) => void> }));
const graph = vi.hoisted(() => ({
  state: {
    isExecuting: false,
    nodes: [] as Array<{ id: string }>,
    edges: [] as Array<{ source: string; target: string }>,
    executeNode: vi.fn(),
    executeCluster: vi.fn(),
    adoptAcceptedProposal: vi.fn(),
    beginUndoStep: vi.fn(() => ({})),
    cancelUndoStep: vi.fn(),
    endUndoStep: vi.fn(),
  },
}));
const api = vi.hoisted(() => ({ acceptProposal: vi.fn(), rejectProposal: vi.fn(), releaseApproval: vi.fn() }));

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { subscribe: (handler: (event: unknown) => void) => { ws.handlers.push(handler); return () => {}; } },
}));
const syncs = vi.hoisted(() => ({ seen: new Set<string>(), stop: vi.fn() }));
vi.mock('../src/store/graphStore', () => ({ useGraphStore: { getState: () => graph.state },
  watchGraphSyncs: () => syncs }));
vi.mock('../src/lib/canvasProposals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/canvasProposals')>()),
  acceptProposal: api.acceptProposal,
  rejectProposal: api.rejectProposal,
  releaseApproval: api.releaseApproval,
}));

const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');

function proposal(id: string, overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id, status: 'open', agent: { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true },
    note: 'Upscale it', projectId: 'p', createdAt: Date.now(), expiresAt: Date.now() + 900_000,
    nodes: [{ ref: '+up', definitionId: 'nano-banana', name: 'Nano Banana', category: 'image', params: {},
      position: { x: 400, y: 0 }, cost: { kind: 'paid', provider: 'google', label: 'paid · google' },
      runs: true, willRun: true, ports: { inputs: [{ id: 'prompt', label: 'Prompt', dataType: 'Text' }], outputs: [] } }],
    edges: [{ source: 'n1', sourceHandle: 'text', target: '+up', targetHandle: 'prompt' }],
    params: [], run: ['+up'],
    cost: { paidRuns: 1, freeRuns: 0, estimate: null, upTo: false, providers: ['google'], nodes: [], note: '' },
    references: ['n1'], reason: null, idMap: null, runNodeIds: null, ...overrides,
  };
}

function emit(event: unknown) {
  for (const handler of ws.handlers) handler(event);
}

beforeEach(() => {
  useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null, deferredQueue: [] } as never);
  graph.state.isExecuting = false;
  graph.state.nodes = [{ id: 'n1' }, { id: 'n7' }];
  graph.state.edges = [];
  for (const fn of [graph.state.executeNode, graph.state.executeCluster, graph.state.adoptAcceptedProposal,
    api.acceptProposal, api.rejectProposal, api.releaseApproval]) fn.mockReset();
  // As the real store: once adopted, the run's nodes are on the canvas (the
  // accept's run is sent only while they are: review 11, L-5).
  graph.state.adoptAcceptedProposal.mockImplementation((result: { runNodeIds?: string[] }) => {
    const ids = new Set(graph.state.nodes.map((node) => node.id));
    graph.state.nodes = [...graph.state.nodes, ...(result.runNodeIds ?? []).filter((id) => !ids.has(id)).map((id) => ({ id }))];
  });
  graph.state.beginUndoStep.mockClear();
  graph.state.cancelUndoStep.mockClear();
  graph.state.endUndoStep.mockClear();
});

// Review 16, L-2 (round 17): a second proposal accepted while a run was going
// overwrote the first's held run without releasing its approval. Decision:
// held runs queue in order; none is dropped, each runs once (or gets its
// existing refusal line), and no approval is ever left held.
describe('held runs queue (review 16, L-2)', () => {
  const acceptWhileRunning = async (id: string, nodeIds: string[], approvalId: string | null) => {
    emit({ type: 'proposalOpened', proposal: proposal(id), acceptKey: `key-${id}` });
    graph.state.isExecuting = true;
    api.acceptProposal.mockResolvedValue({ idMap: {}, runNodeIds: nodeIds, approvalId, nodes: [], edges: [], updatedNodes: [] });
    await useCanvasProposalsStore.getState().accept(id);
  };
  const held = () => useCanvasProposalsStore.getState().deferredRun;

  it('a second accepted proposal waits behind the first: none is dropped, each runs once, in order', async () => {
    graph.state.nodes = [{ id: 'n1' }, { id: 'n7' }, { id: 'n8' }];
    await acceptWhileRunning('p_a', ['n7'], 'ra_a');
    await acceptWhileRunning('p_b', ['n8'], 'ra_b');
    expect(held()).toEqual({ agentName: 'Codex', nodeIds: ['n7'], approvalId: 'ra_a' });
    expect(api.releaseApproval).not.toHaveBeenCalled();
    graph.state.isExecuting = false;
    await useCanvasProposalsStore.getState().runDeferred();
    expect(graph.state.executeNode).toHaveBeenCalledWith('n7', { approvalId: 'ra_a' });
    // The next one shows now, and runs on its own Run.
    expect(held()).toEqual({ agentName: 'Codex', nodeIds: ['n8'], approvalId: 'ra_b' });
    await useCanvasProposalsStore.getState().runDeferred();
    expect(graph.state.executeNode).toHaveBeenCalledWith('n8', { approvalId: 'ra_b' });
    expect(graph.state.executeNode).toHaveBeenCalledTimes(2);
    expect(held()).toBeNull();
    await useCanvasProposalsStore.getState().runDeferred();
    expect(graph.state.executeNode).toHaveBeenCalledTimes(2);
  });

  it('dismissing the first releases its approval only, and shows the next', async () => {
    await acceptWhileRunning('p_a', ['n7'], 'ra_a');
    await acceptWhileRunning('p_b', ['n7'], 'ra_b');
    useCanvasProposalsStore.getState().dismissDeferred();
    expect(api.releaseApproval).toHaveBeenCalledTimes(1);
    expect(api.releaseApproval).toHaveBeenCalledWith('ra_a');
    expect(held()).toEqual({ agentName: 'Codex', nodeIds: ['n7'], approvalId: 'ra_b' });
    useCanvasProposalsStore.getState().dismissDeferred();
    expect(api.releaseApproval).toHaveBeenCalledWith('ra_b');
    expect(held()).toBeNull();
  });

  it('another graph on the canvas releases every held approval', async () => {
    await acceptWhileRunning('p_a', ['n7'], 'ra_a');
    await acceptWhileRunning('p_b', ['n7'], 'ra_b');
    await acceptWhileRunning('p_c', ['n7'], null);
    emit({ type: 'graphSync', graphReplaced: true, nodes: [], edges: [] });
    expect(held()).toBeNull();
    expect(api.releaseApproval.mock.calls.map(([id]) => id).sort()).toEqual(['ra_a', 'ra_b']);
    graph.state.isExecuting = false;
    await useCanvasProposalsStore.getState().runDeferred();
    expect(graph.state.executeNode).not.toHaveBeenCalled();
  });

  it('a queued run whose nodes are gone gives its approval back when its turn comes', async () => {
    graph.state.nodes = [{ id: 'n1' }, { id: 'n7' }, { id: 'n8' }];
    await acceptWhileRunning('p_a', ['n7'], 'ra_a');
    await acceptWhileRunning('p_b', ['n8'], 'ra_b');
    graph.state.nodes = [{ id: 'n1' }, { id: 'n7' }];
    graph.state.isExecuting = false;
    await useCanvasProposalsStore.getState().runDeferred();
    await useCanvasProposalsStore.getState().runDeferred();
    expect(graph.state.executeNode).toHaveBeenCalledTimes(1);
    expect(api.releaseApproval).toHaveBeenCalledWith('ra_b');
    expect(held()).toBeNull();
  });
});
