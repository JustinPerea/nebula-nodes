import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProposalView } from '../src/lib/wsClient';

/**
 * PR #216 round 3l (GM r69 a; review 4 logic LOW-1): a keyboard Accept or
 * Reject moves focus when the proposal closes only while focus is still on
 * the card or <body>. Put elsewhere meanwhile (typing in a field while a big
 * Accept applies), it stays there; the decision is said in the region's
 * polite line either way. And review 4's surviving focus mutants, pinned
 * (R16-R18).
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

const { ProposalBar, DECISION_FOCUS_ATTR } = await import('../src/components/canvas/ProposalBar');
const { decisionLine } = await import('../src/lib/canvasProposals');
const { SAY_ATTR } = await import('../src/lib/noticeSay');
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
let say: HTMLElement;
beforeEach(() => {
  useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
  graph.state.undoNotice = null;
  net.apiFetch.mockReset();
  graph.state.adoptAcceptedProposal.mockReset();
  canvas = document.createElement('div');
  canvas.className = 'canvas-wrapper';
  canvas.tabIndex = 0;
  document.body.appendChild(canvas);
  say = document.createElement('div');
  say.setAttribute(SAY_ATTR, '');
  say.setAttribute('aria-live', 'polite');
  document.body.appendChild(say);
});
afterEach(() => {
  cleanup();
  document.querySelectorAll('.canvas-wrapper, [data-test-notice], [data-notice-say], [data-test-field]').forEach((el) => el.remove());
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


function field(): HTMLInputElement {
  const input = document.createElement('input');
  input.setAttribute('data-test-field', '');
  document.body.appendChild(input);
  return input;
}

const ACCEPTED = { status: 'accepted', proposalId: 'p_a', idMap: {}, runNodeIds: [], approvalId: null, nodes: [], edges: [], updatedNodes: [] };

describe('round 3l (GM r69 a): focus moved elsewhere while the decision is out stays there', () => {
  it('Reject, the last card: focus put in a field meanwhile stays in it; the decision is said politely', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    let answer!: (value: Response) => void;
    net.apiFetch.mockReturnValue(new Promise<Response>((done) => { answer = done; }));
    render(<ProposalBar />);
    await press('Reject');
    const input = field();
    act(() => { input.focus(); });
    await act(async () => { answer(respond(200, { status: 'rejected' })); });
    await focusOverTime();
    expect(document.activeElement).toBe(input);
    expect(canvas.hasAttribute(DECISION_FOCUS_ATTR)).toBe(false);
    expect(say.textContent).toBe('Rejected the proposal from Codex.');
  });

  it('Accept with another card open: focus put in a field stays there, not on the next card', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    useCanvasProposalsStore.getState().open(proposal('p_b', 2), 'key-b');
    let answer!: (value: Response) => void;
    net.apiFetch.mockReturnValue(new Promise<Response>((done) => { answer = done; }));
    render(<ProposalBar />);
    await press('Accept');
    const input = field();
    act(() => { input.focus(); });
    await act(async () => { answer(respond(200, ACCEPTED)); });
    await focusOverTime();
    expect(document.activeElement).toBe(input);
    expect(say.textContent).toBe('Accepted the proposal from Codex.');
  });

  it('focus still on the card: it moves as before (the canvas, marked), and the decision is said too', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    net.apiFetch.mockResolvedValue(respond(200, { status: 'rejected' }));
    render(<ProposalBar />);
    await press('Reject');
    await focusOverTime();
    expect(document.activeElement).toBe(canvas);
    expect(canvas.hasAttribute(DECISION_FOCUS_ATTR)).toBe(true);
    expect(say.textContent).toBe(decisionLine('reject', 'Codex'));
  });

  it('focus dropped to <body> meanwhile: it still moves (never left on body)', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    let answer!: (value: Response) => void;
    net.apiFetch.mockReturnValue(new Promise<Response>((done) => { answer = done; }));
    render(<ProposalBar />);
    await press('Reject');
    act(() => { (document.activeElement as HTMLElement).blur(); });
    expect(document.activeElement).toBe(document.body);
    await act(async () => { answer(respond(200, { status: 'rejected' })); });
    await focusOverTime();
    expect(document.activeElement).toBe(canvas);
  });

  it('a mouse decision says nothing and moves nothing', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    net.apiFetch.mockResolvedValue(respond(200, { status: 'rejected' }));
    render(<ProposalBar />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reject' }), { detail: 1 }); });
    await wait(100);
    expect(say.textContent).toBe('');
  });

  it('the canvas is marked only once it has focus: an inert canvas (a dialog open) keeps no mark', async () => {
    // Inert behind a dialog: focus() lands nowhere.
    canvas.focus = () => {};
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    net.apiFetch.mockResolvedValue(respond(200, { status: 'rejected' }));
    render(<ProposalBar />);
    await press('Reject');
    await wait(100);
    expect(document.activeElement).not.toBe(canvas);
    expect(canvas.hasAttribute(DECISION_FOCUS_ATTR)).toBe(false);
  });
});

describe('review 4 NIT-1: the focus mutants, pinned', () => {
  it('R16: an Undo notice that draws a frame after the card goes still takes focus (the retry)', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    net.apiFetch.mockResolvedValue(respond(200, ACCEPTED));
    graph.state.adoptAcceptedProposal.mockImplementation(() => {
      graph.state.undoNotice = { id: 7, text: 'Codex changed the canvas.', offer: 'undo' };
      // The notice's row lands a frame later.
      requestAnimationFrame(() => {
        const slot = document.createElement('div');
        slot.setAttribute('data-notice-slot', 'canvas');
        slot.setAttribute('data-test-notice', '');
        slot.innerHTML = '<div class="canvas-undo-notice"><span>Codex changed the canvas.</span><button type="button">Undo</button></div>';
        document.body.appendChild(slot);
      });
    });
    render(<ProposalBar />);
    await press('Accept');
    await focusOverTime();
    expect(document.activeElement).toBe(document.querySelector('.canvas-undo-notice'));
  });

  it('R17: a new notice with no Undo is not the decision\'s: the canvas', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    net.apiFetch.mockResolvedValue(respond(200, ACCEPTED));
    graph.state.adoptAcceptedProposal.mockImplementation(() => {
      graph.state.undoNotice = { id: 8, text: 'Codex connected 2 nodes.', offer: null };
      const slot = document.createElement('div');
      slot.setAttribute('data-notice-slot', 'canvas');
      slot.setAttribute('data-test-notice', '');
      slot.innerHTML = '<div class="canvas-undo-notice"><span>Codex connected 2 nodes.</span></div>';
      document.body.appendChild(slot);
    });
    render(<ProposalBar />);
    await press('Accept');
    await focusOverTime();
    expect(document.activeElement).toBe(canvas);
  });

  it('R18: a refused decision forgets itself: the proposal closing later (withdrawn) moves no focus', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    net.apiFetch.mockResolvedValue(respond(409, { detail: 'The canvas changed.' }));
    render(<ProposalBar />);
    await press('Reject');
    await wait(100);
    const card = document.querySelector('.proposal-bar');
    expect(document.activeElement).toBe(card);
    // Focus still on the card, the agent withdraws it: the card's own leave
    // moves focus as any notice's does, and nothing is said or marked as a
    // decision's.
    act(() => { useCanvasProposalsStore.getState().close({ proposalId: 'p_a', status: 'withdrawn' } as never); });
    await focusOverTime();
    expect(canvas.hasAttribute(DECISION_FOCUS_ATTR)).toBe(false);
    expect(say.textContent).toBe('');
  });
});
