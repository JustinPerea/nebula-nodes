// PR #200 fix round 20, GM r30 item 7: while the person gate is held (the
// server's demote set it; its promote clears it, lib/personSession), the
// proposal bar's Accept and Reject are disabled with their reasons. Both call
// person-only routes (main._decidable_proposal: require_person). They come
// back on promote and go again on demote. Review 17 LOW-1: an Accept or
// Reject refused for the gate stops saying so once the tab is promoted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocked, lockLine } from './helpers/personLock';
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
  return { useGraphStore, watchGraphSyncs: () => ({ seen: new Set<string>(), stop: () => {} }) };
});

const { ProposalBar } = await import('../src/components/canvas/ProposalBar');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');
const { useUIStore } = await import('../src/store/uiStore');
const session = await import('../src/lib/personSession');

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
  net.apiFetch.mockReset();
});
afterEach(() => {
  cleanup();
  session.resetPersonSessionForTests();
  useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false } });
});

const acceptButton = () => screen.getByRole('button', { name: 'Accept & run (1 paid)' }) as HTMLButtonElement;
const rejectButton = () => screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
const ACCEPT_HELD = 'You can review this when this tab is connected as you.'; // one line for both (GM r17 item 2)
const REJECT_HELD = 'You can review this when this tab is connected as you.'; // one line for both (GM r17 item 2)

describe('GM r30 item 7: Accept and Reject hold with the person gate', () => {
  it('held: both disabled with their reasons, nothing sent; Show still works', async () => {
    open(proposal('p_a'));
    act(() => session.reportPersonRequired());
    render(<ProposalBar />);
    expect(blocked(acceptButton())).toBe(true);
    expect(lockLine(acceptButton())).toBe(ACCEPT_HELD);
    expect(blocked(rejectButton())).toBe(true);
    expect(lockLine(rejectButton())).toBe(REJECT_HELD);
    await act(async () => { fireEvent.click(acceptButton()); fireEvent.click(rejectButton()); });
    expect(net.apiFetch).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Show' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('promoted: both live again; demoted: held again, from the same signal', () => {
    open(proposal('p_a'));
    render(<ProposalBar />);
    expect(blocked(acceptButton())).toBe(false);
    expect(acceptButton().title).toBeFalsy();
    act(() => session.reportPersonRequired());
    expect(blocked(acceptButton())).toBe(true);
    expect(blocked(rejectButton())).toBe(true);
    act(() => session.notePersonPromoted());
    expect(blocked(acceptButton())).toBe(false);
    expect(blocked(rejectButton())).toBe(false);
    expect(rejectButton().title).toBeFalsy();
    act(() => session.reportPersonRequired());
    expect(lockLine(acceptButton())).toBe(ACCEPT_HELD);
    expect(lockLine(rejectButton())).toBe(REJECT_HELD);
  });

  it('a link taken in alone is not the server\'s promote: still held', () => {
    open(proposal('p_a'));
    act(() => session.reportPersonRequired());
    render(<ProposalBar />);
    act(() => { window.dispatchEvent(new CustomEvent(session.PERSON_CONNECTED_EVENT)); });
    expect(blocked(acceptButton())).toBe(true);
  });

  it('review 17 LOW-1: an Accept refused by the gate stops saying so once promoted; another error stays', async () => {
    open(proposal('p_a'));
    open(proposal('p_b', { createdAt: Date.now() + 1 }), 'key-b');
    net.apiFetch.mockResolvedValueOnce(respond(403, { detail: 'Only the person can do this.', code: 'person_required' }));
    render(<ProposalBar />);
    await act(async () => { fireEvent.click(acceptButton()); });
    expect(useCanvasProposalsStore.getState().errors.p_a).toContain('isn’t connected as you');
    act(() => useCanvasProposalsStore.setState((state) => ({ errors: { ...state.errors, p_b: 'This proposal no longer fits the canvas.' } })));
    act(() => session.notePersonPromoted());
    expect(useCanvasProposalsStore.getState().errors.p_a).toBeUndefined();
    expect(useCanvasProposalsStore.getState().errors.p_b).toBe('This proposal no longer fits the canvas.');
  });
});
