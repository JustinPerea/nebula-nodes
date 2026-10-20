import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

// An agent's edit_canvas with arrange:true, on a 1280 x 800 canvas at zoom 1
// with no floating chrome (so 40 px of fit padding on every side).
const flow = vi.hoisted(() => ({
  setViewport: vi.fn(),
  state: {
    transform: [0, 0, 1] as [number, number, number],
    width: 1280,
    height: 800,
    minZoom: 0.1,
    nodes: [] as Array<{ dragging?: boolean }>,
    userSelectionActive: false,
    nodeLookup: new Map<string, { measured: { width: number; height: number } }>(),
  },
}));
const graph = vi.hoisted(() => ({
  nodes: [] as Array<{ id: string; position: { x: number; y: number } }>,
  completeArrange: vi.fn(async () => 'arranged' as const),
}));

vi.mock('@xyflow/react', () => ({
  useStoreApi: () => ({ getState: () => flow.state }),
  useReactFlow: () => ({ setViewport: flow.setViewport }),
}));
vi.mock('../src/store/graphStore', () => ({
  useGraphStore: { getState: () => ({ nodes: graph.nodes, edges: [] }) },
  completeArrange: graph.completeArrange,
}));

const { ArrangeController } = await import('../src/components/canvas/ArrangeController');
const { useArrangeStore } = await import('../src/store/arrangeStore');

function agentPlaced(x: number, y: number, width: number, height: number) {
  graph.nodes = [{ id: 'n7', position: { x, y } }];
  flow.state.nodeLookup = new Map([['n7', { measured: { width, height } }]]);
  const card = document.createElement('div');
  card.className = 'react-flow__node';
  card.dataset.id = 'n7';
  document.body.appendChild(card);
}

async function arrange() {
  render(<ArrangeController />);
  act(() => {
    useArrangeStore.getState().setPending([{ id: 'a_1', nodeIds: ['n7'], direction: 'right', gap: 120 }]);
  });
  await act(async () => { vi.advanceTimersByTime(600); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  // Reduced motion: the view jumps instead of springing, so the target is exact.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
  useArrangeStore.setState({ pending: [], finished: [] });
  graph.completeArrange.mockClear();
  flow.setViewport.mockReset();
});
afterEach(() => {
  document.querySelectorAll('.react-flow__node').forEach((node) => node.remove());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ArrangeController placement', () => {
  it('lands arranged nodes inside what the person can see', async () => {
    // The agent put the node above the screen, where the top bar would hide it.
    agentPlaced(300, -400, 240, 180);
    await arrange();

    expect(graph.completeArrange).toHaveBeenCalledWith('a_1', { n7: { x: 300, y: 40 } });
    // It landed in view, so the view stays where the person left it.
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('brings a block too big for the view into sight', async () => {
    agentPlaced(300, -400, 1400, 900);
    await arrange();

    expect(graph.completeArrange).toHaveBeenCalledWith('a_1', { n7: { x: 300, y: -400 } });
    const [viewport] = flow.setViewport.mock.calls.at(-1)!;
    expect(viewport.zoom).toBeLessThan(1);
    expect(300 * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(40);
    expect(-400 * viewport.zoom + viewport.y).toBeGreaterThanOrEqual(40);
    expect((300 + 1400) * viewport.zoom + viewport.x).toBeLessThanOrEqual(1240);
  });
});
