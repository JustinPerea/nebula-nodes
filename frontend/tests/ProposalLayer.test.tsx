import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ProposalView } from '../src/lib/wsClient';

const flow = vi.hoisted(() => ({
  state: {
    transform: [0, 0, 2] as [number, number, number],
    nodeLookup: new Map<string, unknown>(),
  },
}));

vi.mock('@xyflow/react', () => ({
  useStore: (selector: (state: typeof flow.state) => unknown) => selector(flow.state),
  useStoreApi: () => ({ getState: () => flow.state, subscribe: () => () => {} }),
  ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../src/store/graphStore', () => ({ useGraphStore: { getState: () => ({}) } }));

const { ProposalLayer } = await import('../src/components/canvas/ProposalLayer');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');

function proposal(): ProposalView {
  return {
    id: 'p_a', status: 'open', agent: { id: 'codex', name: 'Codex', color: '#5B9DFF', verified: true },
    note: 'Generate', projectId: 'p', createdAt: Date.now(), expiresAt: Date.now() + 600_000,
    nodes: [{ ref: '+up', definitionId: 'nano-banana', name: 'Nano Banana', category: 'image',
      params: { aspect_ratio: '16:9', nested: { a: 1 } }, position: { x: 400, y: 10 },
      cost: { kind: 'paid', provider: 'google', label: 'paid · google' }, runs: true, willRun: true,
      ports: { inputs: [{ id: 'prompt', label: 'Prompt', dataType: 'Text' }], outputs: [] } }],
    edges: [{ source: 'n1', sourceHandle: 'text', target: '+up', targetHandle: 'prompt' }],
    params: [{ nodeId: 'n1', name: 'Text (n1)', changes: { value: { from: 'a', to: 'b' } } }],
    run: ['+up'],
    cost: { paidRuns: 1, freeRuns: 0, estimate: null, upTo: false, providers: ['google'], nodes: [], note: '' },
    references: ['n1'], reason: null, idMap: null, runNodeIds: null,
  };
}

beforeEach(() => {
  // Reduced motion: ghosts start at rest so transforms are exact.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
  flow.state.nodeLookup = new Map([['n1', {
    id: 'n1', measured: { width: 200, height: 100 }, internals: { positionAbsolute: { x: 0, y: 0 } },
  }]]);
  useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
  useCanvasProposalsStore.getState().open(proposal(), 'key-a');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ProposalLayer', () => {
  it('draws a ghost card, a dashed wire and a ring around the changed node', () => {
    const { container, getByText } = render(<ProposalLayer />);
    const ghost = container.querySelector<HTMLElement>('.proposal-ghost')!;
    expect(ghost.style.transform).toBe('translate(400px, 10px) scale(1)');
    expect(getByText('Nano Banana')).toBeTruthy();
    expect(getByText('paid · google')).toBeTruthy();
    expect(getByText(/proposed by Codex/)).toBeTruthy();
    // Objects are not shown as param lines.
    expect(container.textContent).toContain('16:9');
    expect(container.textContent).not.toContain('nested');
    const wire = container.querySelector<SVGPathElement>('.proposal-wire')!;
    // n1 has no handle bounds here, so the wire starts at its header; it ends at the ghost's prompt dot.
    expect(wire.getAttribute('d')).toMatch(/^M 100 44 C .* 400 66$/);
    const ring = container.querySelector<HTMLElement>('.proposal-ring')!;
    expect(ring.style.transform).toBe('translate(-6px, -6px)');
    // The ring shows the values, not just the key.
    expect(ring.textContent).toBe('proposed: value: a → b');
    // The nested param isn't drawn on the card, so the card says so.
    expect(container.querySelector('.proposal-ghost__more')!.textContent).toBe('+1 more setting · full values in the bar');
    const wrapper = container.querySelector<HTMLElement>('.proposal-ghosts')!;
    expect(wrapper.style.getPropertyValue('--agent-color')).toBe('#5B9DFF');
  });

  it('drags a ghost in flow units (screen delta divided by zoom)', () => {
    const { container } = render(<ProposalLayer />);
    const ghost = container.querySelector<HTMLElement>('.proposal-ghost')!;
    fireEvent.pointerDown(ghost, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(ghost, { pointerId: 1, clientX: 160, clientY: 40 });
    fireEvent.pointerUp(ghost, { pointerId: 1, clientX: 160, clientY: 40 });
    expect(useCanvasProposalsStore.getState().drag.p_a['+up']).toEqual({ x: 430, y: -20 });
    fireEvent.pointerMove(ghost, { pointerId: 1, clientX: 500, clientY: 500 });
    expect(useCanvasProposalsStore.getState().drag.p_a['+up']).toEqual({ x: 430, y: -20 });
  });

  it('prefers the exact values the canvas received over the agent-facing ones', () => {
    const long = 'warm golden hour light '.repeat(4);
    useCanvasProposalsStore.getState().open(proposal(), 'key-a', {
      nodes: { '+up': { aspect_ratio: '1:1' } },
      params: { n1: { value: { from: 'a', to: long } } },
    });
    const { container } = render(<ProposalLayer />);
    expect(container.querySelector('.proposal-ghost')!.textContent).toContain('1:1');
    const tag = container.querySelector<HTMLElement>('.proposal-ring__tag')!;
    expect(tag.textContent).toContain('value: a → warm golden hour light');
    expect(tag.title).toContain(long.trim().slice(0, 60));
  });

  it('fades closing proposals', () => {
    useCanvasProposalsStore.getState().close({ proposalId: 'p_a', status: 'rejected' });
    const { container } = render(<ProposalLayer />);
    expect(container.querySelector('.proposal-ghosts--closing')).not.toBeNull();
  });
});
