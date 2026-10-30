/**
 * PR #204 round 6, review 4 NIT-1 (survivor M2): in the lock's first 150 ms on a page not answered
 * yet, Accept and Reject keep their look (aria-disabled, data-held-pending, not disabled), so a
 * press reaches their handler: it must send nothing.
 */
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

describe('survivor M2: a press in the lock\'s first moment sends nothing', () => {
  it('Accept and Reject, aria-disabled and pending, do nothing on a click', async () => {
    session.resetPersonSessionForTests({ unanswered: true });
    open(proposal('p_a'));
    render(<ProposalBar />);
    for (const button of [acceptButton(), rejectButton()]) {
      expect([button.disabled, button.getAttribute('aria-disabled'), button.hasAttribute('data-held-pending')]).toEqual([false, 'true', true]);
      await act(async () => { fireEvent.click(button); });
    }
    expect(net.apiFetch).not.toHaveBeenCalled();
    expect(useCanvasProposalsStore.getState().pending).toEqual({});
  });
});
