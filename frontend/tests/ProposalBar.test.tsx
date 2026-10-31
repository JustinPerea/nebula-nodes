import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProposalView } from '../src/lib/wsClient';
import { keyIdolInEachTest } from './helpers/keyedSpace';

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
    notify: vi.fn(),
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
  return { useGraphStore, watchGraphSyncs: () => ({ seen: new Set<string>(), stop: () => {} }) };
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
    net.apiFetch, flow.fitBounds, flow.getInternalNode, graph.state.notify]) fn.mockReset();
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
  // The lock tests below run on a keyed route: Idol made keyed for the test
  // (tests/helpers/keyedSpace.ts). Idol itself is keyless from PR #203 round 7.
  keyIdolInEachTest();

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
      expect(screen.queryByText(/Run them when the current run finishes/)).toBeNull();
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
    expect(screen.getByRole('button', { name: 'Accept and run 1 paid' })).toBeTruthy();
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
      fireEvent.click(screen.getByRole('button', { name: 'Accept and run 1 paid' }));
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
      fireEvent.click(screen.getByRole('button', { name: 'Accept and run 1 paid' }));
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
      fireEvent.click(screen.getByRole('button', { name: 'Accept and run 1 paid' }));
    });
    expect(graph.state.executeNode).not.toHaveBeenCalled();
    expect(screen.getByText(/Run them when the current run finishes/)).toBeTruthy();
  });

  it('locks the held "Run" while its nodes need the token, focusable, and runDeferred refuses too (GM r8 item 3)', async () => {
    const LINE = 'You can run Idol after you add your Hugging Face token in Settings.';
    const before = graph.state.nodes;
    graph.state.nodes = [{ id: 'n9', data: { label: 'Idol', definitionId: 'speridlabs-idol', params: {} } } as never];
    try {
      useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds: ['n9'], approvalId: 'ap-1' } });
      useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
      render(<DeferredRunNotice />);
      const run = screen.getByRole('button', { name: 'Run' });
      expect(run).toHaveAttribute('aria-disabled', 'true');
      expect(run).not.toBeDisabled();
      expect(run).toHaveAttribute('data-key-locked', '');
      expect(run).toHaveAttribute('title', LINE);
      expect(run).toHaveAccessibleDescription(LINE);
      run.focus();
      expect(document.activeElement).toBe(run);
      fireEvent.click(run);
      expect(graph.state.executeNode).not.toHaveBeenCalled();
      // A locked button does nothing on a click, as the toolbar's Run: its reason is its description.
      expect(graph.state.notify).not.toHaveBeenCalled();
      // The store's backstop: the same refusal as a notice, nothing sent, the offer kept.
      await useCanvasProposalsStore.getState().runDeferred();
      expect(graph.state.executeNode).not.toHaveBeenCalled();
      expect(graph.state.notify).toHaveBeenCalledWith(LINE, 'info');
      expect(useCanvasProposalsStore.getState().deferredRun?.nodeIds).toEqual(['n9']);
      // With the token it is Run again.
      act(() => useUIStore.setState({ settingsCache: { apiKeys: { HF_TOKEN: 'set' }, loaded: true } }));
      expect(screen.getByRole('button', { name: 'Run' })).not.toHaveAttribute('aria-disabled');
    } finally {
      graph.state.nodes = before;
    }
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
      fireEvent.click(screen.getByRole('button', { name: 'Accept and run 1 paid' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('no longer fits the canvas');
    expect(graph.state.executeNode).not.toHaveBeenCalled();

    net.apiFetch.mockResolvedValueOnce(respond(403, { detail: 'nope' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept and run 1 paid' }));
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
      fireEvent.click(screen.getByRole('button', { name: 'Accept and run 1 paid' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Accept and run 1 paid' }));
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
    const list = screen.getByRole('list', { name: 'Can’t run here' });
    expect(list.textContent).toContain('GPT Image 2 (+img) needs OPENAI_API_KEY in Settings > Providers');
    // The canvas Run button stays enabled for a node without its key: the
    // backend refuses that node before anything is spent. Accept does the same.
    const accept = screen.getByRole('button', { name: 'Accept and run 1 paid' }) as HTMLButtonElement;
    expect(accept.disabled).toBe(false);

    // The person adds the key while the proposal is open: the line goes.
    act(() => useUIStore.setState({ settingsCache: { apiKeys: { OPENAI_API_KEY: 'set' }, loaded: true } }));
    expect(screen.queryByRole('list', { name: 'Can’t run here' })).toBeNull();
  });

  it('locks Accept with GM\'s line while its run needs a Hugging Face token (PR #203 r6 item 1)', () => {
    const LINE = 'You can accept this after you add your Hugging Face token in Settings.';
    const idol = proposal('p_a', {
      nodes: [{ ...proposal('p_a').nodes[0], ref: '+idol', definitionId: 'speridlabs-idol', name: 'Idol' }],
      run: ['+idol'],
    });
    idol.cost = { ...idol.cost, paidRuns: 0, freeRuns: 1, notReady: [
      { ref: '+idol', nodeId: null, name: 'Idol', missing: 'needs HF_TOKEN in Settings > Providers',
        person: 'You can run Idol after you add your Hugging Face token in Settings.' },
    ] };
    open(idol);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    render(<ProposalBar />);
    const accept = screen.getByRole('button', { name: /^Accept/ }) as HTMLButtonElement;
    expect(accept).toHaveAttribute('aria-disabled', 'true');
    expect(accept.disabled).toBe(false);
    expect(accept).toHaveAttribute('title', LINE);
    expect(accept).toHaveAccessibleDescription(LINE);
    accept.focus();
    expect(document.activeElement).toBe(accept);
    fireEvent.click(accept);
    expect(net.apiFetch).not.toHaveBeenCalled();
    // Reject still works: only what would run is locked.
    expect(screen.getByRole('button', { name: 'Reject' })).not.toHaveAttribute('aria-disabled');

    // The person adds the token: Accept is Accept again.
    act(() => useUIStore.setState({ settingsCache: { apiKeys: { HF_TOKEN: 'set' }, loaded: true } }));
    const ready = screen.getByRole('button', { name: /^Accept/ });
    expect(ready).not.toHaveAttribute('aria-disabled');
    expect(ready).not.toHaveAttribute('title', LINE);
  });

  it('the bar\'s "can\'t run here" line for a keyed route is the Accept line, and goes once the token is added (PR #203 rounds 6 and 7)', () => {
    // The row as the backend sends it: Idol's route line is `missing` too
    // (node_readiness.instance_missing), not find_nodes' "needs HF_TOKEN".
    const ROW = 'You can run Idol after you add your Hugging Face token in Settings.';
    const idol = proposal('p_a', {
      nodes: [{ ...proposal('p_a').nodes[0], ref: '+idol', definitionId: 'speridlabs-idol', name: 'Idol' }],
      run: ['+idol'],
    });
    idol.cost = { ...idol.cost, paidRuns: 0, freeRuns: 1, notReady: [
      { ref: '+idol', nodeId: null, name: 'Idol', missing: ROW, person: ROW },
    ] };
    open(idol);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    render(<ProposalBar />);
    // GM r11 item 5: inside the bar the control is Accept, so the line is
    // the Accept line, said once, never the node's Run line.
    const list = screen.getByRole('list', { name: 'Can’t run here' });
    expect(list).toHaveTextContent('You can accept this after you add your Hugging Face token in Settings.');
    expect(screen.queryByText(ROW)).toBeNull();
    expect(list.querySelectorAll('li')).toHaveLength(1);
    act(() => useUIStore.setState({ settingsCache: { apiKeys: { HF_TOKEN: 'set' }, loaded: true } }));
    expect(screen.queryByRole('list', { name: 'Can’t run here' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Accept/ })).not.toHaveAttribute('aria-disabled');
  });

  it('locks Accept once the token is removed, for a proposal made while it was set (review r4 LOW-1)', () => {
    const LINE = 'You can accept this after you add your Hugging Face token in Settings.';
    // Made while the token was set: the backend listed nothing that can't run.
    const idol = proposal('p_a', {
      nodes: [{ ...proposal('p_a').nodes[0], ref: '+idol', definitionId: 'speridlabs-idol', name: 'Idol' }],
      run: ['+idol'],
    });
    idol.cost = { ...idol.cost, paidRuns: 0, freeRuns: 1 };
    open(idol);
    useUIStore.setState({ settingsCache: { apiKeys: { HF_TOKEN: 'set' }, loaded: true } });
    render(<ProposalBar />);
    expect(screen.getByRole('button', { name: /^Accept/ })).not.toHaveAttribute('aria-disabled');
    act(() => useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } }));
    const accept = screen.getByRole('button', { name: /^Accept/ });
    expect(accept).toHaveAttribute('aria-disabled', 'true');
    expect(accept).toHaveAccessibleDescription(LINE);
    fireEvent.click(accept);
    expect(net.apiFetch).not.toHaveBeenCalled();
  });

  it("locks Accept when its run pulls in an Idol already on the canvas (the run's plan)", () => {
    const LINE = 'You can accept this after you add your Hugging Face token in Settings.';
    const before = graph.state.nodes;
    graph.state.nodes = [{ id: 'n1', data: { label: 'Idol', definitionId: 'speridlabs-idol', params: {} } } as never];
    try {
      const fed = proposal('p_a', {
        nodes: [{ ...proposal('p_a').nodes[0], ref: '+prev', definitionId: 'preview', name: 'Preview',
          cost: { kind: 'free', provider: null, label: 'free' } } as never],
        edges: [{ source: 'n1', sourceHandle: 'world', target: '+prev', targetHandle: 'input' }],
        params: [], run: ['+prev'], references: ['n1'],
      });
      fed.cost = { ...fed.cost, paidRuns: 0, freeRuns: 1 };
      open(fed);
      useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
      render(<ProposalBar />);
      expect(screen.getByRole('button', { name: /^Accept/ })).toHaveAccessibleDescription(LINE);
    } finally {
      graph.state.nodes = before;
    }
  });

  it("every way to accept refuses in the store with GM's line and sends nothing (review r4 LOW-2)", async () => {
    const LINE = 'You can accept this after you add your Hugging Face token in Settings.';
    const idol = proposal('p_a', {
      nodes: [{ ...proposal('p_a').nodes[0], ref: '+idol', definitionId: 'speridlabs-idol', name: 'Idol' }],
      run: ['+idol'],
    });
    open(idol);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    // Not the bar's button: the store's accept, which the layer's ghost
    // card, the keyboard and agents' prompts all call.
    await useCanvasProposalsStore.getState().accept('p_a');
    expect(net.apiFetch).not.toHaveBeenCalled();
    expect(graph.state.notify).toHaveBeenCalledWith(LINE, 'info');
    expect(useCanvasProposalsStore.getState().pending.p_a).toBeUndefined();
    expect(graph.state.executeNode).not.toHaveBeenCalled();
    // With the token, the same call is sent.
    net.apiFetch.mockResolvedValue(respond(200, { status: 'accepted', idMap: { '+idol': 'n9' }, runNodeIds: ['n9'] }));
    useUIStore.setState({ settingsCache: { apiKeys: { HF_TOKEN: 'set' }, loaded: true } });
    await useCanvasProposalsStore.getState().accept('p_a');
    expect(net.apiFetch).toHaveBeenCalled();
  });

  const notReadyOf = (count: number) => {
    const many = proposal('p_a');
    many.cost = { ...many.cost, notReady: ['+a', '+b', '+c', '+d', '+e'].slice(0, count).map((ref) => ({
      ref, nodeId: null, name: 'FLUX 3', missing: `FLUX 3 can't run on BFL: no BFL_API_KEY (${ref})` })) };
    open(many);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    render(<ProposalBar />);
    return screen.getByRole('list', { name: 'Can’t run here' });
  };

  it('keeps a reason the canvas cannot re-check, a line for each of up to 3 nodes', () => {
    const list = notReadyOf(3);
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['+a', '+b', '+c'].map((ref) =>
      `⚠${ref}: FLUX 3 can't run on BFL: no BFL_API_KEY (${ref})`));
    expect(list.textContent).not.toContain('more');
  });

  // GM, PR #203 r24: the shared rule names up to 3 and counts from 4, so 4
  // is never "3 and 1 more": one line, and every node in the details.
  it.each([4, 5])('counts %i nodes in one line and lists every one in the details', (count) => {
    const list = notReadyOf(count);
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([`⚠${count} nodes can’t run here yet.`]);
    // The details hold the list and what Accept writes: one name for both
    // (GM, PR #203 r27 item 4), following its state.
    const toggle = screen.getByRole('button', { name: 'Show the details' });
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide the details' })).toBe(toggle);
    expect(screen.queryByRole('button', { name: /See what Accept writes|Show the list/ })).toBeNull();
    const details = screen.getByLabelText('What Accept writes');
    for (const ref of ['+a', '+b', '+c', '+d', '+e'].slice(0, count)) expect(details.textContent).toContain(`(${ref})`);
  });

  // GM, PR #203 r27 item 7: same-named nodes with the same reason say one
  // line in the person's list, the count in front of the single line's
  // sentence; another node keeps its own line.
  const KREA_LINE = '“Krea 2” needs your Krea plan. Sign in to Krea in Settings.';
  const sameNamed = (krea: number) => {
    const many = proposal('p_a');
    many.nodes = [];
    many.params = [];
    many.cost = { ...many.cost, notReady: [
      ...Array.from({ length: krea }, (_, index) => ({ ref: `+k${index}`, nodeId: null, name: 'Krea 2',
        missing: 'needs the Krea account signed in (Settings > Providers > Krea)', person: KREA_LINE })),
      { ref: '+c', nodeId: null, name: 'Claude', missing: 'needs ANTHROPIC_API_KEY in Settings > Providers',
        person: '“Claude” needs your Anthropic API key. Add it in Settings.' },
    ] };
    open(many);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    render(<ProposalBar />);
  };

  it('says two same-named nodes in one line, the count in front', () => {
    sameNamed(2);
    const list = screen.getByRole('list', { name: 'Can’t run here' });
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '⚠2 “Krea 2” nodes need your Krea plan. Sign in to Krea in Settings.',
      '⚠“Claude” needs your Anthropic API key. Add it in Settings.',
    ]);
  });

  it('counts 4 nodes, and says three same-named ones in one line in the list', () => {
    sameNamed(3);
    const list = screen.getByRole('list', { name: 'Can’t run here' });
    expect(list.textContent).toBe('⚠4 nodes can’t run here yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Show the list' }));
    expect([...screen.getByLabelText('Details').querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      '3 “Krea 2” nodes need your Krea plan. Sign in to Krea in Settings.',
      '“Claude” needs your Anthropic API key. Add it in Settings.',
    ]);
  });

  // GM, PR #203 r26: one toggle, one name: "Show the list" / "Hide the
  // list"; the heading inside is "Can’t run here". Its name follows its
  // state and focus stays on it.
  it('opens the list with "Show the list" and closes it with "Hide the list", focus kept on the toggle', () => {
    const many = proposal('p_a');
    many.nodes = [];
    many.params = [];
    many.cost = { ...many.cost, notReady: ['+a', '+b', '+c', '+d'].map((ref) => ({
      ref, nodeId: null, name: 'FLUX 3', missing: `FLUX 3 can't run on BFL: no BFL_API_KEY (${ref})` })) };
    open(many);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    render(<ProposalBar />);
    const toggle = screen.getByRole('button', { name: 'Show the list' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    toggle.focus();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide the list' })).toBe(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveFocus();
    const details = screen.getByLabelText('Details');
    expect(details.textContent).toContain('(+d)');
    expect(details.querySelector('h3')?.textContent).toBe('Can’t run here');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show the list' })).toBe(toggle);
    expect(toggle).toHaveFocus();
    expect(screen.queryByLabelText('Details')).toBeNull();
    expect(document.body.textContent).not.toContain('See every node');
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
    const accept = screen.getByRole('button', { name: 'Accept and run 1 paid' });
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
    expect(screen.getByRole('button', { name: 'Accept and run 1 paid' })).toBeEnabled();
    resetBackendConnectionForTests();
  });
});

// GM, PR #203 r11 item 3, and the round 6 review's LOW-1: Accept goes through
// withKeyLock like every Run surface, so a missing key comes first, ahead of
// offline, and a key-locked Accept carries no offline mark.
describe('ProposalBar Accept: the missing key leads the canvas lock (keyed route)', () => {
  keyIdolInEachTest();

  it('offline with the key missing: key-locked, focusable, the Accept line, no offline mark; online it stays key-locked', async () => {
    const LINE = 'You can accept this after you add your Hugging Face token in Settings.';
    const { noteBackendConnection, resetBackendConnectionForTests } = await import('../src/lib/backendConnection');
    resetBackendConnectionForTests();
    const idol = proposal('p_a', {
      nodes: [{ ...proposal('p_a').nodes[0], ref: '+idol', definitionId: 'speridlabs-idol', name: 'Idol' }],
      run: ['+idol'],
    });
    open(idol);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    render(<ProposalBar />);
    act(() => noteBackendConnection('offline'));
    const accept = screen.getByRole('button', { name: /^Accept/ }) as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
    expect(accept).toHaveAttribute('aria-disabled', 'true');
    expect(accept).toHaveAttribute('data-key-locked', '');
    expect(accept).not.toHaveAttribute('data-offline-disabled');
    expect(accept).toHaveAttribute('title', LINE);
    fireEvent.click(accept);
    expect(net.apiFetch).not.toHaveBeenCalled();
    // Reject has no key to wait for: offline holds it.
    expect(screen.getByRole('button', { name: /^Reject/ })).toBeDisabled();
    act(() => noteBackendConnection('online'));
    expect(screen.getByRole('button', { name: /^Accept/ })).toHaveAttribute('title', LINE);
    resetBackendConnectionForTests();
  });

  it('following an agent\'s switch with the key missing: the key line, no following mark; with the key, the wait line', async () => {
    const LINE = 'You can accept this after you add your Hugging Face token in Settings.';
    const { setFollowingSwitch, resetCanvasFollowForTests } = await import('../src/lib/canvasFollow');
    const { FOLLOWING_MARK } = await import('../src/lib/canvasLock');
    const idol = proposal('p_a', {
      nodes: [{ ...proposal('p_a').nodes[0], ref: '+idol', definitionId: 'speridlabs-idol', name: 'Idol' }],
      run: ['+idol'],
    });
    open(idol);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    render(<ProposalBar />);
    act(() => setFollowingSwitch({ projectName: 'Second canvas', agent: 'Codex' }));
    const accept = screen.getByRole('button', { name: /^Accept/ });
    expect(accept).toHaveAttribute('title', LINE);
    expect(accept).toHaveAttribute('data-key-locked', '');
    expect(accept).not.toHaveAttribute(FOLLOWING_MARK);
    act(() => useUIStore.setState({ settingsCache: { apiKeys: { HF_TOKEN: '***abcd' }, loaded: true } }));
    const held = screen.getByRole('button', { name: /^Accept/ });
    expect(held).not.toHaveAttribute('data-key-locked');
    expect(held).toHaveAttribute('title', 'Wait for “Second canvas” to open.');
    expect(held).toHaveAttribute(FOLLOWING_MARK);
    act(() => { resetCanvasFollowForTests(); setFollowingSwitch(null); });
  });
});

describe('ProposalBar with Idol, keyless (GM, PR #203 r11 item 2 and r12)', () => {
  const idolNode = () => ({ ...proposal('p_a').nodes[0], ref: '+idol', definitionId: 'speridlabs-idol', name: 'Idol',
    cost: { kind: 'mayCost', provider: 'speridlabs', label: 'may cost · Hugging Face' } }) as never;

  it('Idol alone with a token: "Accept and run" with "1 may cost", its own clause, and no estimate line', () => {
    const view = proposal('p_a', { nodes: [idolNode()], edges: [], params: [], run: ['+idol'] });
    view.cost = { ...view.cost, paidRuns: 0, freeRuns: 0, mayCostRuns: 1, providers: [], estimate: null,
      mayCost: [{ name: 'Idol', account: 'Hugging Face' }] };
    open(view);
    useUIStore.setState({ settingsCache: { apiKeys: { HF_TOKEN: 'set' }, loaded: true } });
    render(<ProposalBar />);
    const accept = screen.getByRole('button', { name: 'Accept and run 1 may cost' });
    expect(accept).not.toHaveAttribute('aria-disabled');
    expect(accept.querySelector('.proposal-bar__count')).toHaveAttribute('title', 'Idol can use your Hugging Face credits.');
    expect(document.querySelector('.proposal-bar__summary')).toHaveTextContent(/^Adds 1 node · runs Idol · may use your Hugging Face credits$/);
    expect(document.querySelector('.proposal-bar__meta')?.textContent).toMatch(/^expires in \d+:\d\d$/);
    expect(screen.queryByText(/paid|No list price|\$0/)).toBeNull();
  });

  const mixed = () => {
    const view = proposal('p_a', { nodes: [idolNode(), proposal('p_a').nodes[0]], edges: [], params: [], run: ['+idol', '+up', 'n4'] });
    view.cost = { ...view.cost, paidRuns: 2, freeRuns: 0, mayCostRuns: 1, upTo: false, providers: ['google'],
      mayCost: [{ name: 'Idol', account: 'Hugging Face' }],
      nodes: [
        { ref: '+idol', nodeId: null, definitionId: 'speridlabs-idol', kind: 'mayCost', provider: 'speridlabs',
          label: 'may cost · Hugging Face', name: 'Idol', account: 'Hugging Face' },
        { ref: '+up', nodeId: null, definitionId: 'nano-banana', kind: 'paid', provider: 'google', label: 'paid · google' },
        { ref: 'n4', nodeId: 'n4', definitionId: 'nano-banana', kind: 'paid', provider: 'google', label: 'paid · google' },
      ],
      estimate: { currency: 'usd', low: 0.13, high: 0.13, open: false, unpriced: [], plan: [], plus: [] } };
    return view;
  };

  it('mixed: GM r14 items 2 and 3, verbatim: two lines, no provider tag, and the Accept chip\'s sentences', () => {
    graph.state.nodes = [{ id: 'n4', data: { definitionId: 'nano-banana', label: 'Hero still', params: {} } }] as never;
    open(mixed());
    useUIStore.setState({ settingsCache: { apiKeys: { HF_TOKEN: 'set' }, loaded: true } });
    render(<ProposalBar />);
    const accept = screen.getByRole('button', { name: 'Accept and run 2 paid · 1 may cost' });
    expect(document.querySelector('.proposal-bar__summary')?.textContent).toBe(
      'Adds 2 nodes · runs 2 paid models and Idol · Idol may use your Hugging Face credits');
    expect(document.querySelector('.proposal-bar__meta')?.textContent).toMatch(
      /^~\$0\.13 · List prices, not a quote · expires in \d+:\d\d$/);
    expect(document.querySelector('.proposal-bar__summary')?.textContent).not.toMatch(/google|\(/);
    expect(accept.querySelector('.proposal-bar__count')).toHaveAttribute('title',
      '“Nano Banana” and “Hero still” call paid providers. Estimated cost $0.13. Idol can use your Hugging Face credits.');
    graph.state.nodes = [];
  });

  it('re-reads Idol from the keys set now, both ways (GM r15 item 2; review 7, NIT-5)', () => {
    // Proposed with the token; the person removed it since.
    open(mixed());
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    render(<ProposalBar />);
    expect(screen.getByRole('button', { name: 'Accept and run 2 paid' })).toBeTruthy();
    // Without Idol's clause the shared form stands, tag and all (GM: the wording batch).
    expect(document.querySelector('.proposal-bar__summary')?.textContent).toBe('Adds 2 nodes · runs 2 paid models (google) · ~$0.13');
    // The chip still has its cost tooltip, by the Run chip's formatter (GM,
    // PR #203 r17 item 4); n4 isn't on this canvas, so it goes by its id.
    expect(document.querySelector('.proposal-bar__count')).toHaveAttribute('title',
      '“Nano Banana” and “n4” call paid providers. Estimated cost $0.13.');
    // And added again: "may cost" comes back without a new proposal.
    act(() => useUIStore.setState({ settingsCache: { apiKeys: { HF_TOKEN: '***abcd' }, loaded: true } }));
    expect(screen.getByRole('button', { name: 'Accept and run 2 paid · 1 may cost' })).toBeTruthy();
    cleanup();
    // Proposed without it (free), the token added since: "may cost".
    const view = mixed();
    view.cost = { ...view.cost, mayCostRuns: 0, mayCost: [], freeRuns: 1,
      nodes: view.cost.nodes.map((entry) => (entry.ref === '+idol'
        ? { ...entry, kind: 'free' as const, label: 'free · Hugging Face' } : entry)) };
    view.nodes = view.nodes.map((node) => (node.ref === '+idol'
      ? { ...node, cost: { kind: 'free', provider: 'speridlabs', label: 'free · Hugging Face' } } : node));
    useCanvasProposalsStore.setState({ proposals: {} });
    open(view);
    useUIStore.setState({ settingsCache: { apiKeys: { HF_TOKEN: 'set' }, loaded: true } });
    render(<ProposalBar />);
    expect(screen.getByRole('button', { name: 'Accept and run 2 paid · 1 may cost' })).toBeTruthy();
    expect(document.querySelector('.proposal-bar__summary')?.textContent).toBe(
      'Adds 2 nodes · runs 2 paid models and Idol · Idol may use your Hugging Face credits');
  });

  it('before this tab has read the keys, the backend\'s classes stand', () => {
    open(mixed());
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false } });
    render(<ProposalBar />);
    expect(screen.getByRole('button', { name: 'Accept and run 2 paid · 1 may cost' })).toBeTruthy();
  });

  it('without a token Idol is free: plain "Accept and run", nothing locked, no chip', () => {
    const view = proposal('p_a', { nodes: [{ ...(idolNode() as object), cost: { kind: 'free', provider: 'speridlabs', label: 'free · Hugging Face' } } as never],
      edges: [], params: [], run: ['+idol'] });
    view.cost = { ...view.cost, paidRuns: 0, freeRuns: 1, providers: [], estimate: null };
    open(view);
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } });
    render(<ProposalBar />);
    const accept = screen.getByRole('button', { name: 'Accept and run' });
    expect(accept).not.toHaveAttribute('aria-disabled');
    expect(accept.querySelector('.proposal-bar__count')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Can’t run here' })).toBeNull();
  });
});
