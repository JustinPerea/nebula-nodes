import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProposalView } from '../src/lib/wsClient';

const flow = vi.hoisted(() => ({ fitBounds: vi.fn(), getInternalNode: vi.fn() }));
const graph = vi.hoisted(() => ({
  state: {
    isExecuting: false,
    nodes: [{ id: 'n1' }],
    edges: [] as Array<{ source: string; target: string }>,
    executeNode: vi.fn(),
    executeCluster: vi.fn(),
    adoptAcceptedProposal: vi.fn(),
    beginUndoStep: vi.fn(() => ({})),
    cancelUndoStep: vi.fn(),
    endUndoStep: vi.fn(),
  },
}));
const net = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@xyflow/react', () => ({
  Panel: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
  useReactFlow: () => flow,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../src/lib/backend', () => ({ apiFetch: net.apiFetch }));
vi.mock('../src/store/graphStore', () => {
  const useGraphStore = (selector: (state: typeof graph.state) => unknown) => selector(graph.state);
  useGraphStore.getState = () => graph.state;
  // DeferredRunNotice reads its nodes' names live (GM r40 item 3).
  const nodeCardTitle = (node: { data?: { label?: string } } | undefined) => node?.data?.label ?? '';
  return { useGraphStore, nodeCardTitle, watchGraphSyncs: () => ({ seen: new Set<string>(), stop: () => {} }) };
});

const { ProposalBar } = await import('../src/components/canvas/ProposalBar');
const { DeferredRunNotice } = await import('../src/components/canvas/DeferredRunNotice');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');
const { useUIStore } = await import('../src/store/uiStore');

function proposal(id: string, overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    id, status: 'open', agent: { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true },
    note: 'Generate the warm take', projectId: 'p', createdAt: Date.now(), expiresAt: Date.now() + 600_000,
    nodes: [{ ref: '+up', definitionId: 'nano-banana', name: 'Nano Banana', category: 'image', params: {},
      position: { x: 400, y: 0 }, cost: { kind: 'paid', provider: 'google', label: 'paid · google' },
      runs: true, willRun: true, ports: { inputs: [{ id: 'prompt', label: 'Prompt', dataType: 'Text' }], outputs: [] } }],
    edges: [{ source: 'n1', sourceHandle: 'text', target: '+up', targetHandle: 'prompt' }],
    params: [{ nodeId: 'n1', name: 'Text (n1)', changes: { value: { from: 'a', to: 'b' } } }],
    run: ['+up'],
    cost: { paidRuns: 1, freeRuns: 0, estimate: null, upTo: true, providers: ['google'], nodes: [], note: '' },
    references: ['n1'], reason: null, idMap: null, runNodeIds: null, ...overrides,
  };
}

function respond(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function open(view: ProposalView, key = 'key-a') {
  useCanvasProposalsStore.getState().open(view, key);
}

beforeEach(() => {
  useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
  graph.state.isExecuting = false;
  for (const fn of [graph.state.executeNode, graph.state.executeCluster, graph.state.adoptAcceptedProposal,
    net.apiFetch, flow.fitBounds, flow.getInternalNode]) fn.mockReset();
  // As the real store: once adopted, the run's nodes are on the canvas (the
  // accept's run is sent only while they are: review 11, L-5).
  graph.state.adoptAcceptedProposal.mockImplementation((result: { runNodeIds?: string[] }) => {
    const ids = new Set(graph.state.nodes.map((node) => node.id));
    graph.state.nodes = [...graph.state.nodes, ...(result.runNodeIds ?? []).filter((id) => !ids.has(id)).map((id) => ({ id }))];
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false } });
});

describe('ProposalBar', () => {
  it('renders nothing without proposals', () => {
    const { container } = render(<ProposalBar />);
    expect(container.innerHTML).toBe('');
  });

  // GM - Design, 2026-10-23: "Proposal-bar notices and every 3g canvas notice"
  // go to the app-level notice region (tests/noticeRegion.test.tsx), so the
  // bar's panel holds only the bar.
  it('leaves its notices to the app\'s notice region', () => {
    const state = graph.state as typeof graph.state & { undoNotice?: unknown };
    state.undoNotice = { id: 1, text: 'Imported. One note.', offer: null, tone: 'info' };
    useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds: ['n7'] } as never });
    try {
      const { container } = render(<ProposalBar />);
      expect(container.innerHTML).toBe('');
      expect(screen.queryByText(/^You can run .+ (?:now|when the current run finishes)\.$/)).toBeNull();
      expect(screen.queryByText('Imported. One note.')).toBeNull();
    } finally {
      delete state.undoNotice;
    }
  });

  it('shows who, what and the paid run label', () => {
    open(proposal('p_a'));
    render(<ProposalBar />);
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Generate the warm take')).toBeTruthy();
    expect(screen.getByText('Adds 1 node · 1 connection · changes n1 · runs up to 1 paid model (google)')).toBeTruthy();
    expect(screen.getByText(/No list price ·/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept & run (1 paid)' })).toBeTruthy();
  });

  it('adds the list-price estimate to the summary when the run has one', () => {
    open(proposal('p_a', { cost: { paidRuns: 1, freeRuns: 0, upTo: true, providers: ['google'], nodes: [], note: '',
      estimate: { currency: 'usd', low: 0.067, high: 0.067, open: false, unpriced: [], plan: [], plus: [] } } }));
    render(<ProposalBar />);
    expect(screen.getByText('Adds 1 node · 1 connection · changes n1 · runs up to 1 paid model (google) · ~$0.07')).toBeTruthy();
    expect(screen.getByText(/List prices, not a quote ·/)).toBeTruthy();
  });

  it('says nothing runs and offers a plain Accept when no run is requested', () => {
    open(proposal('p_a', { run: [], cost: { paidRuns: 0, freeRuns: 0, estimate: null, upTo: false, providers: [], nodes: [], note: '' } }));
    render(<ProposalBar />);
    expect(screen.getByText(/nothing runs until you choose/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
  });

  it('accepts with the key header and dragged positions, adopts, then runs the target', async () => {
    open(proposal('p_a'));
    useCanvasProposalsStore.getState().moveGhost('p_a', '+up', { x: 900, y: -40 });
    net.apiFetch.mockResolvedValue(respond(200, {
      status: 'accepted', proposalId: 'p_a', idMap: { '+up': 'n7' }, runNodeIds: ['n7'], approvalId: 'ra_a',
      nodes: [{ id: 'n7' }], edges: [], updatedNodes: [],
    }));
    render(<ProposalBar />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept & run (1 paid)' }));
    });
    const [path, init] = net.apiFetch.mock.calls[0];
    expect(path).toBe('/api/canvas/proposals/p_a/accept');
    expect((init.headers as Record<string, string>)['X-Nebula-Proposal-Key']).toBe('key-a');
    expect(JSON.parse(init.body as string)).toEqual({ positions: { '+up': { x: 900, y: -40 } } });
    expect(graph.state.adoptAcceptedProposal).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'n7' }] }),
      { undoStep: expect.any(Object), synced: expect.any(Set) });
    expect(graph.state.executeNode).toHaveBeenCalledWith('n7', { approvalId: 'ra_a' });
    // Released after the run call (a no-op once the run used it up).
    expect(net.apiFetch.mock.calls[1][0]).toBe('/api/canvas/approvals/ra_a');
    expect(net.apiFetch.mock.calls[1][1]).toEqual({ method: 'DELETE' });
  });

  it('runs several targets as a cluster with their inputs', async () => {
    open(proposal('p_a'));
    graph.state.edges = [{ source: 'n1', target: 'n7' }];
    net.apiFetch.mockResolvedValue(respond(200, { idMap: {}, runNodeIds: ['n7', 'n8'], nodes: [], edges: [], updatedNodes: [] }));
    render(<ProposalBar />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept & run (1 paid)' }));
    });
    expect(graph.state.executeNode).not.toHaveBeenCalled();
    expect([...graph.state.executeCluster.mock.calls[0][0]].sort()).toEqual(['n1', 'n7', 'n8']);
  });

  it('adds without running while a run is going, then offers Run', async () => {
    open(proposal('p_a'));
    graph.state.isExecuting = true;
    net.apiFetch.mockResolvedValue(respond(200, { idMap: {}, runNodeIds: ['n7'], nodes: [], edges: [], updatedNodes: [] }));
    // The offer is a notice in the app's notice region (NoticeRegion), beside the bar.
    render(<><ProposalBar /><DeferredRunNotice /></>);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept & run (1 paid)' }));
    });
    expect(graph.state.executeNode).not.toHaveBeenCalled();
    expect(screen.getByText(/^You can run .+ when the current run finishes\.$/)).toBeTruthy();
  });

  it('rejects with the key', async () => {
    open(proposal('p_a'));
    net.apiFetch.mockResolvedValue(respond(200, { status: 'rejected' }));
    render(<ProposalBar />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    });
    const [path, init] = net.apiFetch.mock.calls[0];
    expect(path).toBe('/api/canvas/proposals/p_a/reject');
    expect((init.headers as Record<string, string>)['X-Nebula-Proposal-Key']).toBe('key-a');
    expect(useCanvasProposalsStore.getState().proposals.p_a.closing).toBe('rejected');
  });

  it('shows the 409 detail inline, and a reload hint on 403', async () => {
    open(proposal('p_a'));
    net.apiFetch.mockResolvedValueOnce(respond(409, { detail: 'This proposal no longer fits the canvas: n1 is no longer on the canvas' }));
    render(<ProposalBar />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept & run (1 paid)' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('no longer fits the canvas');
    expect(graph.state.executeNode).not.toHaveBeenCalled();

    net.apiFetch.mockResolvedValueOnce(respond(403, { detail: 'nope' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept & run (1 paid)' }));
    });
    expect(screen.getByRole('alert').textContent).toBe('Only the canvas can accept this. Reload the page.');
  });

  it("shows the proposal its Update's Review asked for, and paging moves on from it (Q112 a)", () => {
    open(proposal('p_a', { createdAt: 1 }));
    open(proposal('p_b', { createdAt: 2, note: 'Make the cold take' }), 'key-b');
    render(<ProposalBar />);
    expect(screen.getByText('Generate the warm take')).toBeTruthy();
    act(() => useCanvasProposalsStore.getState().focus('p_b'));
    expect(screen.getByText('Make the cold take')).toBeTruthy();
    expect(screen.getByText(/2 of 2/)).toBeTruthy();
    // The bar can take the keyboard (Review focuses it), never Accept itself.
    expect(document.querySelector('.proposal-bar')?.getAttribute('tabindex')).toBe('-1');
    fireEvent.click(screen.getByRole('button', { name: 'Next proposal' }));
    expect(screen.getByText('Generate the warm take')).toBeTruthy();
    expect(useCanvasProposalsStore.getState().focusedId).toBeNull();
  });

  it('pages between several proposals and frames ghosts with Show', () => {
    open(proposal('p_a', { createdAt: 1, note: 'older' }));
    open(proposal('p_b', { createdAt: 2, note: 'newer' }), 'key-b');
    flow.getInternalNode.mockReturnValue({ internals: { positionAbsolute: { x: 0, y: 0 } }, measured: { width: 200, height: 100 } });
    render(<ProposalBar />);
    // Oldest first: new arrivals join the end of the pager.
    expect(screen.getByText('older')).toBeTruthy();
    expect(screen.getByText(/1 of 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next proposal' }));
    expect(screen.getByText('newer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next proposal' }));
    expect(screen.getByText('older')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    const [bounds] = flow.fitBounds.mock.calls[0];
    expect(bounds).toEqual({ x: 0, y: 0, width: 640, height: 150 });
  });

  it('keeps the proposal the person is reading when another arrives', async () => {
    open(proposal('p_a', { createdAt: 10, note: 'from Codex' }), 'key-a');
    net.apiFetch.mockResolvedValue(respond(200, { idMap: {}, runNodeIds: [], nodes: [], edges: [], updatedNodes: [] }));
    render(<ProposalBar />);
    expect(screen.getByText('from Codex')).toBeTruthy();
    // Claude proposes while the person is about to click Accept on Codex's.
    act(() => {
      open(proposal('p_b', { createdAt: 20, note: 'from Claude',
        agent: { id: 'claude', name: 'Claude Code', color: '#D97757', verified: true } }), 'key-b');
    });
    expect(screen.getByText('from Codex')).toBeTruthy();
    expect(screen.getByText(/1 of 2/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept & run (1 paid)' }));
    });
    const [path, init] = net.apiFetch.mock.calls[0];
    expect(path).toBe('/api/canvas/proposals/p_a/accept');
    expect((init.headers as Record<string, string>)['X-Nebula-Proposal-Key']).toBe('key-a');
  });

  it('ignores a click that lands just as the shown proposal is replaced', () => {
    open(proposal('p_a', { createdAt: 10, note: 'first' }), 'key-a');
    open(proposal('p_b', { createdAt: 20, note: 'second' }), 'key-b');
    render(<ProposalBar />);
    expect(screen.getByText('first')).toBeTruthy();
    // The agent withdraws the shown one; the next takes its place.
    act(() => {
      useCanvasProposalsStore.getState().close({ proposalId: 'p_a', status: 'withdrawn' });
    });
    expect(screen.getByText('second')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept & run (1 paid)' }));
    expect(net.apiFetch).not.toHaveBeenCalled();
  });

  it('lists every value Accept will write, in full, with from and to', () => {
    const long = 'a very long prompt that the ghost card could never show in full '.repeat(3).trim();
    useCanvasProposalsStore.getState().open(proposal('p_a'), 'key-a', {
      nodes: { '+up': { aspect_ratio: '16:9', num_images: 8, prompt: long } },
      params: { n1: { value: { from: 'a', to: 'b' } } },
    });
    render(<ProposalBar />);
    fireEvent.click(screen.getByRole('button', { name: 'See what Accept writes' }));
    const details = screen.getByLabelText('What Accept writes');
    expect(details.textContent).toContain('New Nano Banana (+up)');
    expect(details.textContent).toContain('num_images8');
    expect(details.textContent).toContain(long);
    expect(details.textContent).toContain('Text (n1)');
    expect(details.textContent).toContain('a → b');
  });

  it("names the run's nodes that can't run here, and leaves Accept as the Run button is", () => {
    const keyless = proposal('p_a', {
      nodes: [{ ...proposal('p_a').nodes[0], ref: '+img', definitionId: 'gpt-image-2-generate', name: 'GPT Image 2' }],
      run: ['+img'],
    });
    keyless.cost = { ...keyless.cost, notReady: [
      { ref: '+img', nodeId: null, name: 'GPT Image 2', missing: 'needs OPENAI_API_KEY in Settings > Providers' },
    ] };
    open(keyless);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    render(<ProposalBar />);
    const list = screen.getByRole('list', { name: "Can't run here" });
    expect(list.textContent).toContain('GPT Image 2 (+img) needs OPENAI_API_KEY in Settings > Providers');
    // The canvas Run button stays enabled for a node without its key: the
    // backend refuses that node before anything is spent. Accept does the same.
    const accept = screen.getByRole('button', { name: 'Accept & run (1 paid)' }) as HTMLButtonElement;
    expect(accept.disabled).toBe(false);

    // The person adds the key while the proposal is open: the line goes.
    act(() => useUIStore.setState({ settingsCache: { apiKeys: { OPENAI_API_KEY: 'set' }, loaded: true } }));
    expect(screen.queryByRole('list', { name: "Can't run here" })).toBeNull();
  });

  it('keeps a reason the canvas cannot re-check, and moves a long list into the details', () => {
    const many = proposal('p_a');
    many.cost = { ...many.cost, notReady: ['+a', '+b', '+c', '+d'].map((ref) => ({
      ref, nodeId: null, name: 'FLUX 3', missing: `FLUX 3 can't run on BFL: no BFL_API_KEY (${ref})` })) };
    open(many);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    render(<ProposalBar />);
    const list = screen.getByRole('list', { name: "Can't run here" });
    expect(list.querySelectorAll('li')).toHaveLength(4);
    expect(list.textContent).toContain("+a: FLUX 3 can't run on BFL");
    expect(list.textContent).toContain('and 1 more in the details');
    fireEvent.click(screen.getByRole('button', { name: 'See what Accept writes' }));
    expect(screen.getByLabelText('What Accept writes').textContent).toContain('(+d)');
  });

  it("wraps the agent's note and offers the rest in the details", () => {
    // jsdom lays nothing out: the note reports more height than its three lines show.
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly report: () => void) {}
      observe() { this.report(); }
      disconnect() {}
    });
    const heights = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('proposal-bar__note') ? 120 : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('proposal-bar__note') ? 52 : 0;
    });
    const note = 'Swapped GPT Image 2 for Krea 2 because the OpenAI key is not set here. '.repeat(4).trim();
    open(proposal('p_a', { note, nodes: [], edges: [], params: [], run: [] }));
    render(<ProposalBar />);
    const shown = document.querySelector('.proposal-bar__note')!;
    expect(shown.textContent).toBe(note);
    fireEvent.click(screen.getByRole('button', { name: 'Read the whole note' }));
    expect(screen.getByLabelText('Details').textContent).toContain(note);
    expect(screen.getByRole('button', { name: 'Hide the note' })).toBeTruthy();
    heights.mockRestore();
    client.mockRestore();
  });
});

// Round 15 of PR #114 (review 14, M2): offline, Accept and Reject are
// disabled with the offline mark, and the store refuses them before sending.
describe('ProposalBar while Nebula is offline', () => {
  it('Accept and Reject are disabled and send nothing', async () => {
    const { noteBackendConnection, resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
    resetBackendConnectionForTests();
    open(proposal('p_a'));
    render(<ProposalBar />);
    act(() => noteBackendConnection('offline'));
    const accept = screen.getByRole('button', { name: 'Accept & run (1 paid)' });
    const reject = screen.getByRole('button', { name: /^Reject/ });
    for (const button of [accept, reject]) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('data-offline-disabled');
    }
    await act(async () => {
      await useCanvasProposalsStore.getState().accept('p_a');
      await useCanvasProposalsStore.getState().reject('p_a');
    });
    expect(net.apiFetch).not.toHaveBeenCalled();
    act(() => noteBackendConnection('online'));
    expect(screen.getByRole('button', { name: 'Accept & run (1 paid)' })).toBeEnabled();
    resetBackendConnectionForTests();
  });
});
