import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProposalView } from '../src/lib/wsClient';

/**
 * A mouse Accept or Reject ends with focus on the canvas (or the Undo
 * notice when one was raised), never <body>, and without the keyboard ring
 * mark (design). Keyboard behaviour is pinned in proposalDecisionFocus.round3l.
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
  useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, barShownId: null, deferredRun: null });
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

/** A mouse click: focus on the button (as a pointer leaves it), detail 1. */
async function click(name: string): Promise<void> {
  const button = screen.getByRole('button', { name });
  button.focus();
  await act(async () => { fireEvent.click(button, { detail: 1 }); });
}

/** A mouse click that leaves <body> active, as when the card closes under the pointer: blur, then detail 1. */
async function clickFromBody(name: string): Promise<void> {
  const button = screen.getByRole('button', { name });
  act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  expect(document.activeElement).toBe(document.body);
  await act(async () => { fireEvent.click(button, { detail: 1 }); });
}

async function settle(): Promise<void> {
  for (const ms of [100, 300, 600, 900]) await wait(ms);
}

const ACCEPTED = { status: 'accepted', proposalId: 'p_a', idMap: {}, runNodeIds: [], approvalId: null, nodes: [], edges: [], updatedNodes: [] };

describe('focus after a pointer decision', () => {
  it('mouse Reject, the last card: focus lands on the canvas, not <body>, with no ring mark', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    net.apiFetch.mockResolvedValue(respond(200, { status: 'rejected' }));
    render(<ProposalBar />);
    await click('Reject');
    await settle();
    expect(document.activeElement).toBe(canvas);
    expect(canvas.hasAttribute(DECISION_FOCUS_ATTR)).toBe(false);
    expect(say.textContent).toBe('');
  });

  it('mouse Accept, the last card: focus lands on the canvas, not <body>, with no ring mark', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    net.apiFetch.mockResolvedValue(respond(200, ACCEPTED));
    render(<ProposalBar />);
    await click('Accept');
    await settle();
    expect(document.activeElement).toBe(canvas);
    expect(canvas.hasAttribute(DECISION_FOCUS_ATTR)).toBe(false);
  });

  it('mouse Reject with <body> active when the proposal closes: focus still lands on the canvas, no ring mark', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    net.apiFetch.mockResolvedValue(respond(200, { status: 'rejected' }));
    render(<ProposalBar />);
    await clickFromBody('Reject');
    await settle();
    expect(document.activeElement).toBe(canvas);
    expect(canvas.hasAttribute(DECISION_FOCUS_ATTR)).toBe(false);
  });

  it('mouse Accept with <body> active when the proposal closes: focus still lands on the canvas, no ring mark', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    net.apiFetch.mockResolvedValue(respond(200, ACCEPTED));
    render(<ProposalBar />);
    await clickFromBody('Accept');
    await settle();
    expect(document.activeElement).toBe(canvas);
    expect(canvas.hasAttribute(DECISION_FOCUS_ATTR)).toBe(false);
  });

  it('mouse Accept that raises an Undo notice: focus goes to the notice', async () => {
    const notice = document.createElement('div');
    notice.setAttribute('data-notice-slot', 'canvas');
    notice.setAttribute('data-test-notice', '');
    const row = document.createElement('div');
    row.className = 'canvas-undo-notice';
    notice.appendChild(row);
    document.body.appendChild(notice);
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    net.apiFetch.mockImplementation(async () => {
      graph.state.undoNotice = { id: 7, text: 'Accepted', offer: 'undo' };
      return respond(200, ACCEPTED);
    });
    render(<ProposalBar />);
    await click('Accept');
    await settle();
    expect(document.activeElement).toBe(row);
    expect(canvas.hasAttribute(DECISION_FOCUS_ATTR)).toBe(false);
  });

  it('focus the person moved elsewhere while the mouse decision is out stays there', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    let answer!: (value: Response) => void;
    net.apiFetch.mockReturnValue(new Promise<Response>((done) => { answer = done; }));
    render(<ProposalBar />);
    await click('Reject');
    const input = document.createElement('input');
    input.setAttribute('data-test-field', '');
    document.body.appendChild(input);
    act(() => { input.focus(); });
    await act(async () => { answer(respond(200, { status: 'rejected' })); });
    await settle();
    expect(document.activeElement).toBe(input);
  });

  it('the shown proposal id is published for the Updates corner while the bar is up, and cleared after', async () => {
    useCanvasProposalsStore.getState().open(proposal('p_a', 1), 'key-a');
    const view = render(<ProposalBar />);
    expect(useCanvasProposalsStore.getState().barShownId).toBe('p_a');
    view.unmount();
    expect(useCanvasProposalsStore.getState().barShownId).toBeNull();
  });
});
