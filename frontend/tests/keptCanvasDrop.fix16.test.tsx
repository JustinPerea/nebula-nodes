import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

const flow = vi.hoisted(() => ({
  fitView: vi.fn(), initialized: false,
  internalNodes: new Map<string, { measured: { width?: number; height?: number } }>(),
  fitProp: true,
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...original,
    // The canvas's drop handlers on the pane, as React Flow puts them.
    ReactFlow: ({ children, onDrop, onDragOver }: { children: React.ReactNode;
      onDrop?: (event: React.DragEvent) => void; onDragOver?: (event: React.DragEvent) => void }) =>
      <div data-testid="pane" onDrop={onDrop} onDragOver={onDragOver}>{children}</div>,
    Background: () => null,
    Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    useReactFlow: () => ({
      fitView: flow.fitView, viewportInitialized: flow.initialized,
      screenToFlowPosition: (point: unknown) => point,
      // #195's Delete key reads the selection from React Flow (the merge).
      getNodes: () => useGraphStore.getState().nodes,
      getEdges: () => useGraphStore.getState().edges,
    }),
    useInternalNode: (id: string) => flow.internalNodes.get(id),
    useStore: () => 1,
    // Fit view reads the canvas size to frame open proposals' ghosts (useFitCanvasView).
    useStoreApi: () => ({ getState: () => ({ width: 1280, height: 800, minZoom: 0.1, maxZoom: 2 }), setState: () => {} }),
  };
});
vi.mock('../src/components/SelectionToolbar', () => ({ SelectionToolbar: () => null }));
vi.mock('../src/components/CanvasNavigation', () => ({ CanvasNavigation: () => null }));
vi.mock('../src/components/canvas/CanvasViewReporter', () => ({ CanvasViewReporter: () => null }));
vi.mock('../src/components/canvas/ArrangeController', () => ({ ArrangeController: () => null }));
vi.mock('../src/components/canvas/AgentCursorLayer', () => ({ AgentCursorLayer: () => null }));
vi.mock('../src/components/canvas/PinLayer', () => ({ PinLayer: () => null }));
vi.mock('../src/components/canvas/PinComposer', () => ({ PinComposer: () => null }));
vi.mock('../src/components/canvas/ProposalLayer', () => ({ ProposalLayer: () => null }));
vi.mock('../src/components/canvas/ProposalBar', () => ({ ProposalBar: () => null }));
vi.mock('../src/components/ContextMenu', () => ({ ContextMenu: () => null }));
vi.mock('../src/components/ConnectionPopup', () => ({ ConnectionPopup: () => null }));
vi.mock('../src/lib/canvasSelection', () => ({
  selectedNodeIds: (nodes: Node<NodeData>[]) => nodes.filter((node) => node.selected).map((node) => node.id),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { Canvas } from '../src/components/Canvas';
import { keepCanvasLocally, releaseKeptCanvas, useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { resetBackendConnectionForTests } from '../src/lib/backendConnection';
import { resetKeptCanvasForTests, subscribeKeptPulse } from '../src/lib/keptCanvas';

/**
 * Review 14 of PR #199 (lock-order LOW-1, M8): a library node dropped on a
 * kept canvas lands on this tab only (refuseTabOnlyEdit, not the whole
 * canvas lock): a local node and a kept step, nothing sent, no pulse.
 */
const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const text = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Brief', definitionId: 'text-input', params: { value: '' }, state: 'idle', outputs: {} } } as unknown as Node<NodeData>;

describe('M8: a library drop on a kept canvas', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetBackendConnectionForTests();
    resetKeptCanvasForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    useUIStore.setState(initialUI, true);
    useGraphStore.setState({ nodes: [text], edges: [], undoNotice: null, undoStack: [], redoStack: [], keptUndo: [], keptRedo: [],
      isImportingGraph: false, runHistory: [] } as never);
    keepCanvasLocally();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    cleanup();
    releaseKeptCanvas();
    resetKeptCanvasForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useUIStore.setState(initialUI, true);
    useGraphStore.setState(initialGraph, true);
  });

  it('lands a local node, one kept step, nothing sent, no pulse', async () => {
    let pulses = 0;
    const stop = subscribeKeptPulse(() => { pulses += 1; });
    const { getByTestId } = render(<Canvas />);
    const dataTransfer = { getData: (type: string) => (type === 'application/nebula-node' ? 'text-input' : ''),
      files: [], types: ['application/nebula-node'] };
    await act(async () => { fireEvent.drop(getByTestId('pane'), { dataTransfer, clientX: 300, clientY: 200 }); });
    stop();
    const ids = useGraphStore.getState().nodes.map((node) => node.id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toMatch(/^n\d+$/);
    expect(useGraphStore.getState().keptUndo.at(-1)).toMatchObject({ kind: 'add' });
    expect(pulses).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
