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
      approvalId: 'ra_a', nodes: [], edges: [], updatedNodes: [] };
    api.acceptProposal.mockResolvedValue(result);
    await useCanvasProposalsStore.getState().accept('p_a');
    expect(api.acceptProposal).toHaveBeenCalledWith('p_a', 'key-a', { '+up': { x: 900, y: -40 } });
    // With what syncs carried while the accept was out: those are the syncs' to keep or remove.
    expect(graph.state.adoptAcceptedProposal).toHaveBeenCalledWith(result, { undoStep: expect.any(Object), synced: syncs.seen });
    expect(syncs.stop).toHaveBeenCalled();
    // One undo step for the accept, taken before the request.
    expect(graph.state.beginUndoStep).toHaveBeenCalledTimes(1);
    expect(graph.state.cancelUndoStep).not.toHaveBeenCalled();
    // And ended once its nodes are on the canvas, so an undo pressed meanwhile acts (review 10, L-2).
    expect(graph.state.endUndoStep).toHaveBeenCalledWith(graph.state.beginUndoStep.mock.results[0].value);
    // The run carries the approval, so the backend can check it is what was accepted.
    expect(graph.state.executeNode).toHaveBeenCalledWith('n7', { approvalId: 'ra_a' });
    // Then it is released (a no-op once the run used it), so a run the canvas
    // declined to start never leaves the nodes locked.
    expect(api.releaseApproval).toHaveBeenCalledWith('ra_a');
    expect(api.releaseApproval.mock.invocationCallOrder[0])
      .toBeGreaterThan(graph.state.executeNode.mock.invocationCallOrder[0]);
    expect(useCanvasProposalsStore.getState().proposals.p_a.closing).toBe('accepted');
  });

  it('runs several targets with their inputs, or waits while a run is going', async () => {
    emit({ type: 'proposalOpened', proposal: proposal('p_a'), acceptKey: 'key-a' });
    graph.state.edges = [{ source: 'n1', target: 'n7' }, { source: 'n1', target: 'n8' }];
    api.acceptProposal.mockResolvedValue({ idMap: {}, runNodeIds: ['n7', 'n8'], approvalId: 'ra_a',
      nodes: [], edges: [], updatedNodes: [] });
    await useCanvasProposalsStore.getState().accept('p_a');
    expect(graph.state.executeCluster).toHaveBeenCalledTimes(1);
    expect([...graph.state.executeCluster.mock.calls[0][0]].sort()).toEqual(['n1', 'n7', 'n8']);
    expect(graph.state.executeCluster.mock.calls[0][1]).toEqual({ approvalId: 'ra_a' });

    emit({ type: 'proposalOpened', proposal: proposal('p_b'), acceptKey: 'key-b' });
    graph.state.isExecuting = true;
    api.acceptProposal.mockResolvedValue({ idMap: {}, runNodeIds: ['n7'], approvalId: 'ra_b',
      nodes: [], edges: [], updatedNodes: [] });
    await useCanvasProposalsStore.getState().accept('p_b');
    expect(graph.state.executeNode).not.toHaveBeenCalled();
    expect(useCanvasProposalsStore.getState().deferredRun)
      .toEqual({ agentName: 'Codex', nodeIds: ['n7'], approvalId: 'ra_b' });
    graph.state.isExecuting = false;
    await useCanvasProposalsStore.getState().runDeferred();
    // The held run still carries the approval from the Accept click.
    expect(graph.state.executeNode).toHaveBeenCalledWith('n7', { approvalId: 'ra_b' });
  });

  it('releases the approval when the person dismisses a held run', async () => {
    emit({ type: 'proposalOpened', proposal: proposal('p_a'), acceptKey: 'key-a' });
    graph.state.isExecuting = true;
    api.acceptProposal.mockResolvedValue({ idMap: {}, runNodeIds: ['n7'], approvalId: 'ra_a',
      nodes: [], edges: [], updatedNodes: [] });
    await useCanvasProposalsStore.getState().accept('p_a');
    useCanvasProposalsStore.getState().dismissDeferred();
    expect(useCanvasProposalsStore.getState().deferredRun).toBeNull();
    expect(api.releaseApproval).toHaveBeenCalledWith('ra_a');
    expect(graph.state.executeNode).not.toHaveBeenCalled();
  });

  it('review 5, L1: Accept on a proposal that runs nothing starts no run and holds none, and frees its approval', async () => {
    // Its whole run waits on Codex's placeholders: the button said "Accept" (GM round 5, item 3).
    const waits = { paidRuns: 0, freeRuns: 0, estimate: null, upTo: false, providers: [], nodes: [], note: '',
      pendingSkipped: { count: 2, placeholders: 1, agents: ['Codex'] } };
    for (const executing of [false, true]) {
      graph.state.isExecuting = executing;
      const id = executing ? 'p_b' : 'p_a';
      emit({ type: 'proposalOpened', proposal: proposal(id, { cost: waits as never }), acceptKey: `key-${id}` });
      api.acceptProposal.mockResolvedValue({ idMap: {}, runNodeIds: ['n7'], approvalId: `ra_${id}`,
        nodes: [], edges: [], updatedNodes: [] });
      await useCanvasProposalsStore.getState().accept(id);
      expect(graph.state.executeNode).not.toHaveBeenCalled();
      expect(graph.state.executeCluster).not.toHaveBeenCalled();
      expect(useCanvasProposalsStore.getState().deferredRun).toBeNull();
      expect(api.releaseApproval).toHaveBeenCalledWith(`ra_${id}`);
    }
  });

  it('runs a proposal without listed runs never, and without an approval sends none', async () => {
    emit({ type: 'proposalOpened', proposal: proposal('p_a'), acceptKey: 'key-a' });
    api.acceptProposal.mockResolvedValue({ idMap: {}, runNodeIds: [], approvalId: null,
      nodes: [], edges: [], updatedNodes: [] });
    await useCanvasProposalsStore.getState().accept('p_a');
    expect(graph.state.executeNode).not.toHaveBeenCalled();
    expect(api.releaseApproval).not.toHaveBeenCalled();
  });
});

describe("a person-only refusal on accept or reject (GM, Q116 a)", () => {
  const GM_LINE = "This change needs your OK, and this tab isn't connected as you. Open the link Nebula printed when it started, then try again.";
  it("says GM's line, not the accept-key line", async () => {
    const { ProposalRequestError } = await import('../src/lib/canvasProposals');
    emit({ type: 'proposalOpened', proposal: proposal('p_a'), acceptKey: 'key-a' });
    api.acceptProposal.mockRejectedValue(new ProposalRequestError(403, 'Only the person can do this.',
      { heading: "Couldn't accept the proposal.", detail: 'Only the person can do this.', code: 'person_required' } as never));
    await useCanvasProposalsStore.getState().accept('p_a');
    expect(useCanvasProposalsStore.getState().errors.p_a).toBe(`Couldn't accept the proposal. ${GM_LINE}`);
    api.rejectProposal.mockRejectedValue(new ProposalRequestError(403, 'Only the person can do this.',
      { heading: "Couldn't reject the proposal.", detail: 'Only the person can do this.', code: 'person_required' } as never));
    await useCanvasProposalsStore.getState().reject('p_a');
    expect(useCanvasProposalsStore.getState().errors.p_a).toBe(`Couldn't reject the proposal. ${GM_LINE}`);
  });

  it('a 403 without the code keeps the accept-key line', async () => {
    const { ProposalRequestError } = await import('../src/lib/canvasProposals');
    emit({ type: 'proposalOpened', proposal: proposal('p_a'), acceptKey: 'key-a' });
    api.acceptProposal.mockRejectedValue(new ProposalRequestError(403, 'This proposal can only be accepted from the Nebula canvas.'));
    await useCanvasProposalsStore.getState().accept('p_a');
    expect(useCanvasProposalsStore.getState().errors.p_a).toBe('Only the canvas can accept this. Reload the page.');
  });
});

describe('GM round 22 (4b): Accept after the canvas was cleared or replaced', () => {
  it("says GM's line, read from the answer's code", async () => {
    const { ProposalRequestError } = await import('../src/lib/canvasProposals');
    emit({ type: 'proposalOpened', proposal: proposal('p_a'), acceptKey: 'key-a' });
    api.acceptProposal.mockRejectedValue(new ProposalRequestError(409,
      "Couldn't accept this proposal: the canvas was cleared or replaced after it was made. Make a new proposal for the canvas as it is now.",
      { heading: "Couldn't accept the proposal.", code: 'proposal_canvas_replaced' } as never));
    await useCanvasProposalsStore.getState().accept('p_a');
    expect(useCanvasProposalsStore.getState().errors.p_a).toBe(
      "Couldn't accept this proposal. The canvas was cleared or replaced after it was made. Ask the agent for a new one.");
  });
});
