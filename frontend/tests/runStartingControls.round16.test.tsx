import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Review 15, M-B: a run waiting for its inputs counts as starting, and the
// Run controls show it as their existing disabled state (no new copy).

vi.mock('../src/lib/graphFile', () => ({ saveToFile: vi.fn(), loadFromFile: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    useReactFlow: () => ({ fitView: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(),
      getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })) }),
    useStore: <T,>(selector: (state: { transform: number[]; minZoom: number; maxZoom: number }) => T) =>
      selector({ transform: [0, 0, 1], minZoom: 0.1, maxZoom: 4 }),
    useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }) }),
  };
});

import { Toolbar } from '../src/components/panels/Toolbar';
import { DeferredRunNotice } from '../src/components/canvas/DeferredRunNotice';
import { useGraphStore } from '../src/store/graphStore';
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';

describe('the Run controls while a run waits for its inputs', () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({
      nodes: [{ id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
        data: { label: 'Prompt', definitionId: 'text-input', params: { value: 'a fox' }, state: 'idle', outputs: {} } }],
      edges: [], isExecuting: false, isImportingGraph: false, providerRecoveries: [], providerStartAmbiguities: [],
      createLaunchingIds: [],
    } as never);
  });
  afterEach(() => {
    useGraphStore.setState({ runStarting: false });
    useCanvasProposalsStore.setState({ deferredRun: null });
  });

  it('the canvas Run is disabled while starting, enabled after', () => {
    useGraphStore.setState({ runStarting: true });
    const { rerender } = render(<Toolbar />);
    const run = () => screen.getByRole('button', { name: /^Run/ }) as HTMLButtonElement;
    expect(run().disabled).toBe(true);
    useGraphStore.setState({ runStarting: false });
    rerender(<Toolbar />);
    expect(run().disabled).toBe(false);
  });

  it("an agent's held run waits too", () => {
    useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds: ['n1'], approvalId: null } });
    useGraphStore.setState({ runStarting: true });
    render(<DeferredRunNotice />);
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
