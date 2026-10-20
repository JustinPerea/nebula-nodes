import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ProposalView } from '../src/lib/wsClient';

const flow = vi.hoisted(() => ({
  fitView: vi.fn(),
  setViewport: vi.fn(),
  getNodes: vi.fn(() => [{ id: 'n1', hidden: false }]),
  // One node at the origin, 240 x 160.
  getNodesBounds: vi.fn(() => ({ x: 0, y: 0, width: 240, height: 160 })),
  state: { width: 1200, height: 800, minZoom: 0.1, maxZoom: 2 },
}));

vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  useReactFlow: () => flow,
  useStoreApi: () => ({ getState: () => flow.state }),
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn() } }));

const { useFitCanvasView } = await import('../src/hooks/useFitCanvasView');
const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');

function proposal(): ProposalView {
  return {
    id: 'p_a', status: 'open', agent: { id: 'claude', name: 'Claude Code', color: '#D97757', verified: true },
    note: 'Krea 2 instead', projectId: 'p', createdAt: 1, expiresAt: Date.now() + 600_000,
    // Far to the right of everything on the canvas.
    nodes: [{ ref: '+krea', definitionId: 'krea-2-image', name: 'Krea 2', category: 'image', params: {},
      position: { x: 3000, y: 0 }, cost: { kind: 'paid', provider: 'krea', label: 'paid · krea' },
      runs: true, willRun: true, ports: { inputs: [], outputs: [] } }],
    edges: [], params: [], run: ['+krea'],
    cost: { paidRuns: 1, freeRuns: 0, estimate: null, upTo: false, providers: ['krea'], nodes: [], note: '' },
    references: [], reason: null, idMap: null, runNodeIds: null,
  };
}

beforeEach(() => {
  useCanvasProposalsStore.setState({ proposals: {}, drag: {}, pending: {}, errors: {}, focusedId: null, deferredRun: null });
  for (const fn of [flow.fitView, flow.setViewport]) fn.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('useFitCanvasView', () => {
  it('is plain fitView when no proposal is open', () => {
    const { result } = renderHook(() => useFitCanvasView());
    result.current(200);
    expect(flow.fitView).toHaveBeenCalledWith(expect.objectContaining({ duration: 200 }));
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it("frames an open proposal's ghosts with the nodes", () => {
    useCanvasProposalsStore.getState().open(proposal(), 'key-a');
    const { result } = renderHook(() => useFitCanvasView());
    result.current(200);

    expect(flow.fitView).not.toHaveBeenCalled();
    const [viewport, options] = flow.setViewport.mock.calls[0];
    expect(options).toEqual({ duration: 200 });
    // The ghost's right edge (x 3000 + its width) is on screen.
    const ghostRight = (3000 + 240) * viewport.zoom + viewport.x;
    expect(ghostRight).toBeLessThanOrEqual(1200);
    expect(viewport.x).toBeGreaterThanOrEqual(0);
  });
});
