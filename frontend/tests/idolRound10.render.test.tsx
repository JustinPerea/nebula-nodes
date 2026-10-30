/**
 * PR #203 round 10, as drawn:
 * - GM r19 item 3 (review 9, cost LOW-2): the Accept button's description
 *   is the count chip's tooltip; its name stays the visible text.
 * - Review 9, cost NIT-3: the mutants that survived it.
 *   - C8: the bar places canvas nodes' reasons left to right.
 *   - N8: line 1 has no inline style that could clip it.
 *   - N1: the onboarding tour lets a closing dialog's focus return through.
 *   - N4: a dialog's close returns focus through returnFocusTo.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProposalView } from '../src/lib/wsClient';

const flow = vi.hoisted(() => ({ fitBounds: vi.fn(), getInternalNode: vi.fn() }));
const graph = vi.hoisted(() => ({
  state: {
    isExecuting: false,
    nodes: [] as Array<{ id: string; position?: { x: number; y: number }; data?: Record<string, unknown> }>,
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

vi.mock('@xyflow/react', () => ({
  Panel: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
  useReactFlow: () => flow,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../src/lib/backend', () => ({ apiFetch: vi.fn() }));
vi.mock('../src/store/graphStore', () => {
  const useGraphStore = (selector: (state: typeof graph.state) => unknown) => selector(graph.state);
  useGraphStore.getState = () => graph.state;
  useGraphStore.subscribe = () => () => {};
  return { useGraphStore, watchGraphSyncs: () => ({ seen: new Set<string>(), stop: () => {} }) };
});

const { ProposalBar } = await import('../src/components/canvas/ProposalBar');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');
const { useUIStore } = await import('../src/store/uiStore');
const { OnboardingOverlay } = await import('../src/components/onboarding/OnboardingOverlay');
const { ModalPortal } = await import('../src/components/ModalPortal');
const { returnFocusTo } = await import('../src/lib/modalFocus');

type Row = { ref: string; nodeId: string | null; name: string; kind: 'paid' | 'plan'; reason: Record<string, unknown> };

function proposal(rows: Row[]): ProposalView {
  return {
    id: 'p10', status: 'open', agent: { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true },
    note: 'Run the shots', projectId: 'p', createdAt: Date.now(), expiresAt: Date.now() + 600_000,
    nodes: [], edges: [], params: [], run: rows.map((row) => row.nodeId ?? row.ref),
    cost: {
      paidRuns: rows.filter((row) => row.kind === 'paid').length, planRuns: rows.filter((row) => row.kind === 'plan').length,
      freeRuns: 0, mayCostRuns: 0, mayCost: [], estimate: null, upTo: false, providers: [], note: '',
      nodes: rows.map((row) => ({ ref: row.ref, nodeId: row.nodeId, definitionId: 'claude-chat', kind: row.kind, provider: null,
        label: row.kind === 'plan' ? 'on Krea plan' : '', price: null, reason: row.reason })),
    },
    references: rows.map((row) => row.nodeId).filter(Boolean), reason: null, idMap: null, runNodeIds: null,
  } as unknown as ProposalView;
}

const canvasNode = (id: string, label: string, x: number) => ({ id, position: { x, y: 0 },
  data: { definitionId: 'claude-chat', label, params: {} } });

beforeEach(() => {
  useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
  graph.state.nodes = [];
});
afterEach(() => {
  cleanup();
  useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false } });
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('the Accept button reads its count chip\'s tooltip (GM r19 item 3; review 9, cost LOW-2)', () => {
  it('as its description, with its name the visible text', () => {
    graph.state.nodes = [canvasNode('n1', 'Writer', 0), canvasNode('n2', 'Editor', 100), canvasNode('n3', 'Krea 2', 200)];
    useCanvasProposalsStore.getState().open(proposal([
      { ref: 'n1', nodeId: 'n1', name: 'Writer', kind: 'paid', reason: { kind: 'noPrice' } },
      { ref: 'n2', nodeId: 'n2', name: 'Editor', kind: 'paid', reason: { kind: 'noPrice' } },
      { ref: 'n3', nodeId: 'n3', name: 'Krea 2', kind: 'plan', reason: { kind: 'plan' } },
    ]), 'key-a');
    render(<ProposalBar />);
    const accept = screen.getByRole('button', { name: 'Accept and run 2 paid · 1 on Krea plan' });
    const tooltip = '“Writer” and “Editor” call paid providers.\n“Writer” and “Editor” have no listed price.\n'
      + '“Krea 2” runs on your Krea plan.';
    expect(accept.querySelector('.proposal-bar__count')).toHaveAttribute('title', tooltip);
    // The same text, once: not in the name, read as the description.
    expect(accept).toHaveAccessibleDescription(tooltip);
    expect(document.querySelectorAll(`[id="${accept.getAttribute('aria-describedby')}"]`)).toHaveLength(1);
  });

  it('reads canvas nodes\' reasons left to right, where they sit now (mutant C8)', () => {
    // The proposal lists them right to left; the canvas places them.
    graph.state.nodes = [canvasNode('n1', 'Right', 900), canvasNode('n2', 'Left', 0)];
    useCanvasProposalsStore.getState().open(proposal([
      { ref: 'n1', nodeId: 'n1', name: 'Right', kind: 'paid', reason: { kind: 'noPrice' } },
      { ref: 'n2', nodeId: 'n2', name: 'Left', kind: 'paid', reason: { kind: 'missingKey', keys: ['FAL_KEY'] } },
    ]), 'key-a');
    render(<ProposalBar />);
    const title = document.querySelector('.proposal-bar__count')!.getAttribute('title')!;
    expect(title.indexOf('“Left” can’t be priced')).toBeGreaterThan(-1);
    expect(title.indexOf('“Left” can’t be priced')).toBeLessThan(title.indexOf('“Right” has no listed price.'));
  });

  it('line 1 has no inline style that could hold it to one line (mutant N8)', () => {
    graph.state.nodes = [canvasNode('n1', 'Writer', 0)];
    useCanvasProposalsStore.getState().open(proposal([
      { ref: 'n1', nodeId: 'n1', name: 'Writer', kind: 'paid', reason: { kind: 'noPrice' } },
    ]), 'key-a');
    render(<ProposalBar />);
    const summary = document.querySelector('.proposal-bar__summary')!;
    expect(summary).toBeTruthy();
    expect(summary.getAttribute('style')).toBeNull();
    expect(summary.querySelector('[style]')).toBeNull();
  });
});

describe('at 760 px the bar wraps and the chip moves under the button (GM r19 item 8; review 9, cost NIT-4)', () => {
  it('the button wraps its chip onto its own line, and nothing in the actions clips', async () => {
    const css = (await import('node:fs')).readFileSync(`${process.cwd()}/src/styles/canvasProposals.css`, 'utf8');
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (selector: string) => [...bare.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((match) => match[1].split(',').some((part) => part.trim() === selector)).map((match) => match[2]).join('\n');
    const primary = rule('.proposal-bar__button--primary');
    expect(primary).toMatch(/flex-wrap:\s*wrap/);
    expect(primary).toMatch(/height:\s*auto/);
    const actions = rule('.proposal-bar__actions');
    expect(actions).toMatch(/min-width:\s*0/);
    expect(actions).toMatch(/max-width:\s*100%/);
    expect(actions).not.toMatch(/flex-shrink:\s*0/);
    for (const body of [primary, actions, rule('.proposal-bar__count')]) {
      expect(body).not.toMatch(/ellipsis|overflow:\s*hidden|line-clamp/);
    }
  });
});

describe('the onboarding tour lets a closing dialog\'s focus return through (review 9, cost NIT-3, mutant N1)', () => {
  it('pulls ordinary focus back into the tour, but not the return', () => {
    const outside = document.createElement('button');
    outside.textContent = 'Outside the tour';
    document.body.append(outside);
    act(() => useUIStore.setState({ onboardingActive: true, onboardingStep: 1 }));
    render(<OnboardingOverlay />);
    const card = document.activeElement as HTMLElement;
    expect(card.closest('[role="dialog"]')).toBeTruthy();
    outside.focus();
    expect(outside).not.toHaveFocus();
    returnFocusTo(outside);
    expect(outside).toHaveFocus();
    act(() => useUIStore.setState({ onboardingActive: false }));
  });
});

describe('a dialog\'s close returns focus through returnFocusTo (review 9, cost NIT-3, mutant N4)', () => {
  it('focuses its opener with a visible ring and without scrolling', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Opener';
    document.body.append(opener);
    opener.focus();
    const view = render(<ModalPortal><div role="dialog" aria-modal="true"><button type="button" autoFocus>Inside</button></div></ModalPortal>);
    expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    view.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(opener).toHaveFocus();
    const call = focus.mock.calls.findIndex((_args, index) => focus.mock.contexts[index] === opener);
    expect(call).toBeGreaterThan(-1);
    expect(focus.mock.calls[call][0]).toEqual({ preventScroll: true, focusVisible: true });
  });
});
