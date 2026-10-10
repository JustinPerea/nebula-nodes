import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Node, Viewport } from '@xyflow/react';
import type { NodeData } from '../src/types';
import type { RunRecord } from '../src/lib/runHistory';
import type { ExecutionEvent } from '../src/lib/wsClient';

type CanvasCallbacks = {
  defaultViewport?: Viewport;
  fitView: boolean;
  onMove: (event: null, viewport: Viewport) => void;
  onInit: (instance: { getViewport: () => Viewport }) => void;
};
const flow = vi.hoisted(() => ({
  props: null as CanvasCallbacks | null,
  fitView: vi.fn(),
  initialized: false,
  internalNodes: new Map<string, { measured: { width: number; height: number } }>(),
  onSync: null as ((event: ExecutionEvent) => void) | null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(),
  subscribe: vi.fn((handler: (event: ExecutionEvent) => void) => { flow.onSync = handler; }) } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ReactFlow: (props: CanvasCallbacks & { children: React.ReactNode }) => {
    flow.props = props;
    return <div>{props.children}</div>;
  },
  Background: () => null,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useReactFlow: () => ({ fitView: flow.fitView, viewportInitialized: flow.initialized,
    screenToFlowPosition: (point: unknown) => point }),
  useInternalNode: (id: string) => flow.internalNodes.get(id),
  useStore: () => 1,
}));
vi.mock('../src/components/SelectionToolbar', () => ({ SelectionToolbar: () => null }));
vi.mock('../src/components/CanvasNavigation', () => ({ CanvasNavigation: () => null }));
vi.mock('../src/components/canvas/CanvasViewReporter', () => ({ CanvasViewReporter: () => null }));
vi.mock('../src/components/canvas/AgentCursorLayer', () => ({ AgentCursorLayer: () => null }));
vi.mock('../src/components/ContextMenu', () => ({ ContextMenu: () => null }));
vi.mock('../src/components/ConnectionPopup', () => ({ ConnectionPopup: () => null }));
vi.mock('../src/lib/canvasSelection', () => ({
  selectedNodeIds: (nodes: Node<NodeData>[]) => nodes.filter((node) => node.selected).map((node) => node.id),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { Canvas } from '../src/components/Canvas';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore, type ViewMode } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const camera = { x: -640, y: 380, zoom: 0.48 };
function node(id: string): Node<NodeData> {
  return { id, selected: id === 'motion', position: { x: 1000, y: 1000 },
    data: { label: id, definitionId: 'text', params: { text: 'Saved authoring' }, state: 'idle', outputs: {} } };
}
const history: RunRecord[] = [{ id: 'saved-run', trigger: 'graph', status: 'complete', startedAt: 1,
  snapshot: { nodes: [], edges: [] } }];

beforeEach(() => {
  vi.useFakeTimers();
  flow.fitView.mockReset().mockResolvedValue(true);
  flow.internalNodes.clear();
  flow.initialized = false;
  flow.props = null;
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false,
    addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  useUIStore.setState({ ...initialUI, selectedNodeId: 'motion', canvasViewport: null,
    canvasViewportRevision: 0, canvasFocusRequest: null, viewMode: 'canvas' }, true);
  useGraphStore.setState({ nodes: [node('motion'), node('sibling')], edges: [
    { id: 'wire', source: 'motion', target: 'sibling' },
  ], runHistory: history, isExecuting: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

describe('Canvas workspace continuity', () => {
  it.each<ViewMode>(['create', 'cinema-editor', 'character-editor', 'moodboard-editor', 'editor', 'remotion-editor', 'commons'])(
    'retains the camera, selection, connections and run history through %s', (destination) => {
      const view = render(<Canvas />);
      expect(flow.props?.fitView).toBe(true);
      const graphBefore = useGraphStore.getState();
      act(() => { flow.props!.onMove(null, camera); });
      const oldCallbacks = flow.props!;
      act(() => { useUIStore.setState({ viewMode: destination, commonsEnabled: true }); });
      view.unmount();
      // A late callback from the retired React Flow instance must not store its
      // teardown/reset transform while a new workspace owns the page.
      act(() => { oldCallbacks.onInit({ getViewport: () => ({ x: 0, y: 0, zoom: 1 }) }); });
      act(() => { useUIStore.setState({ viewMode: 'canvas' }); });
      render(<Canvas />);
      expect(flow.props?.defaultViewport).toEqual(camera);
      expect(flow.props?.fitView).toBe(false);
      expect(flow.fitView).not.toHaveBeenCalled();
      expect(useUIStore.getState().selectedNodeId).toBe('motion');
      expect(useGraphStore.getState().nodes).toBe(graphBefore.nodes);
      expect(useGraphStore.getState().edges).toBe(graphBefore.edges);
      expect(useGraphStore.getState().runHistory).toBe(history);
      expect(useGraphStore.getState().nodes.filter((entry) => entry.selected).map((entry) => entry.id)).toEqual(['motion']);
    },
  );

  it('records the initialized empty Canvas camera even before any user pan or zoom', () => {
    useGraphStore.setState({ nodes: [], edges: [] });
    render(<Canvas />);
    act(() => { flow.props!.onInit({ getViewport: () => camera }); });
    expect(useUIStore.getState().canvasViewport).toEqual(camera);
  });

  it('does not restore the temporary origin before the first graph fit has occurred', () => {
    const initial = render(<Canvas />);
    act(() => { flow.props!.onInit({ getViewport: () => ({ x: 0, y: 0, zoom: 1 }) }); });
    expect(useUIStore.getState().canvasViewport).toBeNull();
    act(() => { useUIStore.setState({ viewMode: 'create' }); });
    initial.unmount();
    act(() => { useUIStore.setState({ viewMode: 'canvas' }); });
    render(<Canvas />);
    expect(flow.props?.fitView).toBe(true);
    act(() => { flow.props!.onMove(null, camera); });
    expect(useUIStore.getState().canvasViewport).toEqual(camera);
  });

  it('ignores a retired mount callback even after another Canvas is active', () => {
    const first = render(<Canvas />);
    const retired = flow.props!;
    act(() => { retired.onMove(null, camera); });
    first.unmount();
    render(<Canvas />);
    act(() => { retired.onMove(null, { x: 0, y: 0, zoom: 1 }); });
    act(() => { retired.onInit({ getViewport: () => ({ x: 0, y: 0, zoom: 1 }) }); });
    expect(useUIStore.getState().canvasViewport).toEqual(camera);
  });

  it('keeps a saved camera through a rapid return that leaves before initialization', () => {
    useUIStore.getState().setCanvasViewport(camera);
    const returned = render(<Canvas />);
    act(() => { useUIStore.setState({ viewMode: 'create' }); });
    returned.unmount();
    expect(useUIStore.getState().canvasViewport).toEqual(camera);
  });

  it('treats disabled Commons as the visible Canvas fallback', () => {
    useUIStore.setState({ viewMode: 'commons', commonsEnabled: false });
    render(<Canvas />);
    act(() => { flow.props!.onMove(null, { ...camera, zoom: 0.6 }); });
    expect(useUIStore.getState().canvasViewport).toEqual({ ...camera, zoom: 0.6 });
  });

  it('lets intentional node focus center its target instead of fitting the restored graph', async () => {
    useUIStore.getState().setCanvasViewport(camera);
    useUIStore.getState().requestCanvasNodeFocus('sibling');
    flow.initialized = true;
    flow.internalNodes.set('sibling', { measured: { width: 280, height: 460 } });
    await act(async () => { render(<Canvas />); });
    expect(flow.props?.fitView).toBe(false);
    expect(flow.fitView).toHaveBeenCalledOnce();
    expect(flow.fitView.mock.calls[0][0].nodes).toEqual([{ id: 'sibling' }]);
    expect(useUIStore.getState().selectedNodeId).toBe('sibling');
    act(() => { flow.props!.onMove(null, { x: 440, y: 160, zoom: 1 }); });
    expect(useUIStore.getState().canvasViewport).toEqual({ x: 440, y: 160, zoom: 1 });
  });

  it.each(['replacement', 'clear'] as const)('invalidates the old camera and delayed initialization on graph %s', (action) => {
    useUIStore.getState().setCanvasViewport(camera);
    useUIStore.getState().setCinemaSelectedShot('scene', 'shot-2');
    const view = render(<Canvas />);
    const oldCallbacks = flow.props!;
    act(() => {
      if (action === 'replacement') useGraphStore.getState().loadGraph([node('new-scene')], []);
      else useGraphStore.getState().clearGraph();
      oldCallbacks.onInit({ getViewport: () => camera });
    });
    expect(useUIStore.getState().canvasViewport).toBeNull();
    expect(useUIStore.getState().cinemaSelectedShotIds).toEqual({});
    view.unmount();
    render(<Canvas />);
    expect(flow.props?.defaultViewport).toBeUndefined();
    expect(flow.props?.fitView).toBe(true);
    expect(useGraphStore.getState().runHistory).toBe(history);
  });

  it('preserves the camera during a reconnect hydration that retains the same graph', () => {
    useUIStore.getState().setCanvasViewport(camera);
    useUIStore.getState().setCinemaSelectedShot('scene', 'shot-2');
    useGraphStore.getState().loadGraph([node('motion')], [], { preserveCinemaUploads: true });
    expect(useUIStore.getState().canvasViewport).toEqual(camera);
    expect(useUIStore.getState().cinemaSelectedShotIds).toEqual({ scene: 'shot-2' });
  });

  it('clears navigation context for an authoritative WebSocket graph replacement even with reused node IDs', () => {
    useUIStore.getState().setCanvasViewport(camera);
    useUIStore.getState().setCinemaSelectedShot('motion', 'shot-2');
    render(<Canvas />);
    const oldCallbacks = flow.props!;
    act(() => { flow.onSync!({ type: 'graphSync', graphReplaced: true, empty: false,
      nodes: [node('motion')], edges: [] }); });
    act(() => { oldCallbacks.onInit({ getViewport: () => camera }); });
    expect(useUIStore.getState().canvasViewport).toBeNull();
    expect(useUIStore.getState().cinemaSelectedShotIds).toEqual({});
    expect(useGraphStore.getState().runHistory).toBe(history);
  });

  it('does not discard navigation context on ordinary WebSocket output updates', () => {
    useUIStore.getState().setCanvasViewport(camera);
    useUIStore.getState().setCinemaSelectedShot('motion', 'shot-2');
    act(() => { flow.onSync!({ type: 'graphSync', empty: false, nodes: [node('motion')], edges: [] }); });
    expect(useUIStore.getState().canvasViewport).toEqual(camera);
    expect(useUIStore.getState().cinemaSelectedShotIds).toEqual({ motion: 'shot-2' });
    expect(useGraphStore.getState().runHistory).toBe(history);
  });

  it('drops automatic fits scheduled for a replaced graph', async () => {
    render(<Canvas />);
    act(() => { window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added')); });
    act(() => { useGraphStore.getState().clearGraph(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(flow.fitView).not.toHaveBeenCalled();
  });
});
