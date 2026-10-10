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
  return { useGraphStore };
});

const { ProposalBar } = await import('../src/components/canvas/ProposalBar');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');

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
});
afterEach(cleanup);

describe('ProposalBar', () => {
  it('renders nothing without proposals', () => {
    const { container } = render(<ProposalBar />);
    expect(container.innerHTML).toBe('');
  });

  it('shows who, what and the paid run label', () => {
    open(proposal('p_a'));
    render(<ProposalBar />);
    expect(screen.getByText('Codex')).toBeTruthy();
    expect(screen.getByText('Generate the warm take')).toBeTruthy();
    expect(screen.getByText('Adds 1 node · 1 wire · changes n1 · runs up to 1 paid model (google)')).toBeTruthy();
    expect(screen.getByText(/No price list in Nebula/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept & run (1 paid)' })).toBeTruthy();
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
      status: 'accepted', proposalId: 'p_a', idMap: { '+up': 'n7' }, runNodeIds: ['n7'], nodes: [{ id: 'n7' }], edges: [], updatedNodes: [],
    }));
    render(<ProposalBar />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept & run (1 paid)' }));
    });
    const [path, init] = net.apiFetch.mock.calls[0];
    expect(path).toBe('/api/canvas/proposals/p_a/accept');
    expect((init.headers as Record<string, string>)['X-Nebula-Proposal-Key']).toBe('key-a');
    expect(JSON.parse(init.body as string)).toEqual({ positions: { '+up': { x: 900, y: -40 } } });
    expect(graph.state.adoptAcceptedProposal).toHaveBeenCalledWith(expect.objectContaining({ nodes: [{ id: 'n7' }] }));
    expect(graph.state.executeNode).toHaveBeenCalledWith('n7');
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
    render(<ProposalBar />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept & run (1 paid)' }));
    });
    expect(graph.state.executeNode).not.toHaveBeenCalled();
    expect(screen.getByText(/Run them when the current run finishes/)).toBeTruthy();
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
});
