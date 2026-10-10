import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  },
}));
const api = vi.hoisted(() => ({ acceptProposal: vi.fn(), rejectProposal: vi.fn() }));

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { subscribe: (handler: (event: unknown) => void) => { ws.handlers.push(handler); return () => {}; } },
}));
vi.mock('../src/store/graphStore', () => ({ useGraphStore: { getState: () => graph.state } }));
vi.mock('../src/lib/canvasProposals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/canvasProposals')>()),
  acceptProposal: api.acceptProposal,
  rejectProposal: api.rejectProposal,
}));

const { useCanvasProposalsStore, PROPOSAL_EXIT_MS } = await import('../src/store/canvasProposalsStore');

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
  useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
  graph.state.isExecuting = false;
  graph.state.nodes = [{ id: 'n1' }, { id: 'n7' }];
  graph.state.edges = [];
  for (const fn of [graph.state.executeNode, graph.state.executeCluster, graph.state.adoptAcceptedProposal,
    api.acceptProposal, api.rejectProposal]) fn.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('canvas proposals store', () => {
  it('syncs open proposals, keeps each key in memory and out of the view', () => {
    emit({ type: 'proposalSync', proposals: [
      { ...proposal('p_a'), acceptKey: 'key-a' },
      { ...proposal('p_b', { status: 'accepted' }), acceptKey: 'key-b' },
      proposal('p_c'),
      { ...proposal('p_d', { agent: { id: 'x', name: 'X', color: 'red;}', verified: false } }), acceptKey: 'key-d' },
    ] });
    const { proposals } = useCanvasProposalsStore.getState();
    expect(Object.keys(proposals).sort()).toEqual(['p_a', 'p_d']);
    expect(proposals.p_a.acceptKey).toBe('key-a');
    expect('acceptKey' in proposals.p_a.view).toBe(false);
    // Only a plain hex colour reaches CSS.
    expect(proposals.p_d.view.agent.color).toBe('#5B9DFF');
  });

  it('keeps the exact values from both browser messages beside the view', () => {
    const values = { nodes: { '+up': { prompt: 'full text' } }, params: {} };
    emit({ type: 'proposalSync', proposals: [{ ...proposal('p_a'), acceptKey: 'key-a', personValues: values }] });
    emit({ type: 'proposalOpened', proposal: proposal('p_b'), acceptKey: 'key-b', personValues: values });
    emit({ type: 'proposalOpened', proposal: proposal('p_c'), acceptKey: 'key-c', personValues: 'junk' });
    const { proposals } = useCanvasProposalsStore.getState();
    expect(proposals.p_a.values).toEqual(values);
    expect('personValues' in proposals.p_a.view).toBe(false);
    expect(proposals.p_b.values).toEqual(values);
    expect(proposals.p_c.values).toBeUndefined();
  });

  it('opens, then fades out and drops a closed proposal', () => {
    vi.useFakeTimers();
    emit({ type: 'proposalOpened', proposal: proposal('p_a'), acceptKey: 'key-a' });
    useCanvasProposalsStore.getState().moveGhost('p_a', '+up', { x: 10, y: 20 });
    expect(useCanvasProposalsStore.getState().drag.p_a['+up']).toEqual({ x: 10, y: 20 });
    emit({ type: 'proposalClosed', proposalId: 'p_a', status: 'withdrawn' });
    expect(useCanvasProposalsStore.getState().proposals.p_a.closing).toBe('withdrawn');
    vi.advanceTimersByTime(PROPOSAL_EXIT_MS + 1);
    expect(useCanvasProposalsStore.getState().proposals).toEqual({});
    expect(useCanvasProposalsStore.getState().drag).toEqual({});
  });

  it('clears everything when the graph is replaced', () => {
    emit({ type: 'proposalOpened', proposal: proposal('p_a'), acceptKey: 'key-a' });
    emit({ type: 'graphSync', nodes: [], edges: [], empty: true, graphReplaced: true });
    expect(useCanvasProposalsStore.getState().proposals).toEqual({});
  });

  it('expires proposals locally past their deadline', () => {
    emit({ type: 'proposalOpened', proposal: proposal('p_a', { expiresAt: 1000 }), acceptKey: 'key-a' });
    useCanvasProposalsStore.getState().pruneExpired(2000);
    expect(useCanvasProposalsStore.getState().proposals.p_a.closing).toBe('expired');
  });

  it('accepts with the key and dragged positions, adopts, then runs one target', async () => {
    emit({ type: 'proposalOpened', proposal: proposal('p_a'), acceptKey: 'key-a' });
    useCanvasProposalsStore.getState().moveGhost('p_a', '+up', { x: 900, y: -40 });
    const result = { status: 'accepted', proposalId: 'p_a', idMap: { '+up': 'n7' }, runNodeIds: ['n7'],
      nodes: [], edges: [], updatedNodes: [] };
    api.acceptProposal.mockResolvedValue(result);
    await useCanvasProposalsStore.getState().accept('p_a');
    expect(api.acceptProposal).toHaveBeenCalledWith('p_a', 'key-a', { '+up': { x: 900, y: -40 } });
    expect(graph.state.adoptAcceptedProposal).toHaveBeenCalledWith(result);
    expect(graph.state.executeNode).toHaveBeenCalledWith('n7');
    expect(useCanvasProposalsStore.getState().proposals.p_a.closing).toBe('accepted');
  });

  it('runs several targets with their inputs, or waits while a run is going', async () => {
    emit({ type: 'proposalOpened', proposal: proposal('p_a'), acceptKey: 'key-a' });
    graph.state.edges = [{ source: 'n1', target: 'n7' }, { source: 'n1', target: 'n8' }];
    api.acceptProposal.mockResolvedValue({ idMap: {}, runNodeIds: ['n7', 'n8'], nodes: [], edges: [], updatedNodes: [] });
    await useCanvasProposalsStore.getState().accept('p_a');
    expect(graph.state.executeCluster).toHaveBeenCalledTimes(1);
    expect([...graph.state.executeCluster.mock.calls[0][0]].sort()).toEqual(['n1', 'n7', 'n8']);

    emit({ type: 'proposalOpened', proposal: proposal('p_b'), acceptKey: 'key-b' });
    graph.state.isExecuting = true;
    api.acceptProposal.mockResolvedValue({ idMap: {}, runNodeIds: ['n7'], nodes: [], edges: [], updatedNodes: [] });
    await useCanvasProposalsStore.getState().accept('p_b');
    expect(graph.state.executeNode).not.toHaveBeenCalled();
    expect(useCanvasProposalsStore.getState().deferredRun).toEqual({ agentName: 'Codex', nodeIds: ['n7'] });
    graph.state.isExecuting = false;
    await useCanvasProposalsStore.getState().runDeferred();
    expect(graph.state.executeNode).toHaveBeenCalledWith('n7');
  });
});
