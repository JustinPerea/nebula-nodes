import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProposalView } from '../src/lib/wsClient';

/**
 * PR #216 review 3 LOW-6, GM r57: after Accept or Reject from the keyboard,
 * focus goes to the next card's region if there is one, else to the Undo
 * notice the decision raised, else to the canvas container with no ring.
 * Never <body>, at any moment: the button goes disabled while the decision
 * is out, so focus waits on the card's region meanwhile.
 */
const flow = vi.hoisted(() => ({ fitBounds: vi.fn(), getInternalNode: vi.fn() }));
const graph = vi.hoisted(() => ({
  state: {
    isExecuting: false,
    nodes: [{ id: 'n1' }],
    edges: [] as Array<{ source: string; target: string }>,
    undoNotice: null as null | { id: number; text: string; offer: 'undo' | 'redo' | null },
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

const { ProposalBar, QUIET_FOCUS_ATTR } = await import('../src/components/canvas/ProposalBar');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');

function proposal(id: string, createdAt: number): ProposalView {
  return {
    id, status: 'open', agent: { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true },
    note: 'Edit the notes', projectId: 'p', createdAt, expiresAt: Date.now() + 600_000,
    nodes: [], edges: [], params: [{ nodeId: 'n1', name: 'Notes (n1)', changes: { value: { from: 'a', to: 'b' } } }],
    run: [], cost: { paidRuns: 0, freeRuns: 0, estimate: null, upTo: false, providers: [], nodes: [], note: '' },
    references: ['n1'], reason: null, idMap: null, runNodeIds: null,
  } as unknown as ProposalView;
}

const respond = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
const wait = (ms: number) => act(() => new Promise<void>((done) => { setTimeout(done, ms); }));

let canvas: HTMLElement;
beforeEach(() => {
  useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
  graph.state.undoNotice = null;
  net.apiFetch.mockReset();
  graph.state.adoptAcceptedProposal.mockReset();
  canvas = document.createElement('div');
  canvas.className = 'canvas-wrapper';
  canvas.tabIndex = 0;
  document.body.appendChild(canvas);
});
afterEach(() => {
  cleanup();
  document.querySelectorAll('.canvas-wrapper, [data-test-notice]').forEach((el) => el.remove());
});

/** Enter on a button: focus on it, then a click with detail 0. */
async function press(name: string): Promise<void> {
  const button = screen.getByRole('button', { name });
  button.focus();
  await act(async () => { fireEvent.click(button, { detail: 0 }); });
}

/** Where focus is at several moments after the decision (review 3 p8's 100/400/900/1600 ms). */
async function focusOverTime(): Promise<Element[]> {
  const seen: Element[] = [document.activeElement!];
  let at = 0;
  for (const ms of [100, 400, 900, 1600]) {
    await wait(ms - at);
    at = ms;
    seen.push(document.activeElement!);
  }
  return seen;
}

describe('focus after a keyboard decision (review 3 LOW-6, GM r57)', () => {
  it('Reject with another proposal open: the next card\'s region, never body', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    useCanvasProposalsStore.getState().open(proposal('p_b', 2), 'key-b');
    let answer!: (value: Response) => void;
    net.apiFetch.mockReturnValue(new Promise<Response>((done) => { answer = done; }));
    render(<ProposalBar />);
    await press('Reject');
    // While the decision is out, the button is disabled: focus waits on the card.
    expect(screen.getByRole('button', { name: 'Rejecting…' })).toBeDisabled();
    expect(document.activeElement).toBe(document.querySelector('.proposal-bar'));
    await act(async () => { answer(respond(200, { status: 'rejected' })); });
    const seen = await focusOverTime();
    expect(seen.some((el) => el === document.body)).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Proposal from Codex' }));
    expect(screen.getByRole('button', { name: 'Reject' })).not.toBeDisabled();
    expect(useCanvasProposalsStore.getState().proposals.p_b.closing).toBeUndefined();
  });

  it('the last proposal rejected: the canvas, with no ring; never body', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    net.apiFetch.mockResolvedValue(respond(200, { status: 'rejected' }));
    render(<ProposalBar />);
    await press('Reject');
    const seen = await focusOverTime();
    expect(seen.some((el) => el === document.body || el === null)).toBe(false);
    expect(document.activeElement).toBe(canvas);
    expect(canvas.hasAttribute(QUIET_FOCUS_ATTR)).toBe(true);
    // The quiet mark goes with the focus.
    act(() => { canvas.blur(); });
    expect(canvas.hasAttribute(QUIET_FOCUS_ATTR)).toBe(false);
  });

  it('accepted, and the decision raised an Undo notice: that notice', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    graph.state.undoNotice = { id: 3, text: 'Earlier', offer: null };
    net.apiFetch.mockResolvedValue(respond(200, { status: 'accepted', proposalId: 'p_a', idMap: {}, runNodeIds: [], approvalId: null, nodes: [], edges: [], updatedNodes: [] }));
    graph.state.adoptAcceptedProposal.mockImplementation(() => {
      graph.state.undoNotice = { id: 4, text: 'Codex changed the canvas.', offer: 'undo' };
      const slot = document.createElement('div');
      slot.setAttribute('data-notice-slot', 'canvas');
      slot.setAttribute('data-test-notice', '');
      slot.innerHTML = '<div class="canvas-undo-notice"><span>Codex changed the canvas.</span><button type="button">Undo</button></div>';
      document.body.appendChild(slot);
    });
    render(<ProposalBar />);
    await press('Accept');
    const seen = await focusOverTime();
    expect(seen.some((el) => el === document.body)).toBe(false);
    const notice = document.querySelector('.canvas-undo-notice');
    // The notice itself, never its Undo: a second Enter can't act.
    expect(document.activeElement).toBe(notice);
    expect(notice!.getAttribute('tabindex')).toBe('-1');
  });

  it('a notice raised before the decision is not the decision\'s: the canvas', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    graph.state.undoNotice = { id: 3, text: 'Deleted the node.', offer: 'undo' };
    const slot = document.createElement('div');
    slot.setAttribute('data-notice-slot', 'canvas');
    slot.setAttribute('data-test-notice', '');
    slot.innerHTML = '<div class="canvas-undo-notice"><button type="button">Undo</button></div>';
    document.body.appendChild(slot);
    net.apiFetch.mockResolvedValue(respond(200, { status: 'rejected' }));
    render(<ProposalBar />);
    await press('Reject');
    await wait(50);
    expect(document.activeElement).toBe(canvas);
  });

  it('refused: focus stays on the card, by its error', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    net.apiFetch.mockResolvedValue(respond(409, { detail: 'The canvas changed.' }));
    render(<ProposalBar />);
    await press('Reject');
    const seen = await focusOverTime();
    expect(seen.some((el) => el === document.body)).toBe(false);
    expect(document.activeElement).toBe(document.querySelector('.proposal-bar'));
  });

  it('a mouse click moves no focus', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    useCanvasProposalsStore.getState().open(proposal('p_b', 2), 'key-b');
    net.apiFetch.mockResolvedValue(respond(200, { status: 'rejected' }));
    render(<ProposalBar />);
    const reject = screen.getByRole('button', { name: 'Reject' });
    await act(async () => { fireEvent.click(reject, { detail: 1 }); });
    await wait(50);
    expect(document.activeElement).not.toBe(document.querySelector('.proposal-bar'));
    expect(document.activeElement).not.toBe(canvas);
  });

  it('the canvas\'s quiet focus draws no ring (canvasProposals.css)', () => {
    const css = readFileSync(resolve(__dirname, '../src/styles/canvasProposals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.canvas-wrapper\[data-focus-quiet\]:focus,\s*\.canvas-wrapper\[data-focus-quiet\]:focus-visible \{\s*outline: none;\s*\}/);
    expect(QUIET_FOCUS_ATTR).toBe('data-focus-quiet');
  });
});
