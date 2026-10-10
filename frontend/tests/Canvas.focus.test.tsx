import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
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
    ReactFlow: ({ children, fitView }: { children: React.ReactNode; fitView: boolean }) => {
      flow.fitProp = fitView;
      return <div>{children}</div>;
    },
    Background: () => null,
    Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    useReactFlow: () => ({
      fitView: flow.fitView, viewportInitialized: flow.initialized,
      screenToFlowPosition: (point: unknown) => point,
    }),
    useInternalNode: (id: string) => flow.internalNodes.get(id),
    useStore: () => 1,
  };
});
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

import { Canvas, CanvasFocusController } from '../src/components/Canvas';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
function node(id: string): Node<NodeData> {
  return { id, position: { x: 1000, y: 1000 },
    data: { label: id, definitionId: 'text', params: {}, state: 'idle', outputs: {} } };
}
function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('Canvas requested node focus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    flow.fitView.mockReset().mockResolvedValue(true);
    flow.internalNodes.clear();
    flow.initialized = false;
    flow.fitProp = true;
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false,
      addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    useUIStore.setState(initialUI, true);
    useGraphStore.setState({ nodes: [node('motion'), node('sibling')], edges: [], isExecuting: false });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useUIStore.setState(initialUI, true);
    useGraphStore.setState(initialGraph, true);
  });

  it('keeps a pre-mount handoff until target measurements and the viewport are ready', async () => {
    useUIStore.getState().requestCanvasNodeFocus('motion');
    const request = useUIStore.getState().canvasFocusRequest!;
    const view = render(<CanvasFocusController />);
    expect(flow.fitView).not.toHaveBeenCalled();
    expect(useUIStore.getState().canvasFocusRequest).toBe(request);
    flow.initialized = true;
    flow.internalNodes.set('motion', { measured: { width: 280 } });
    view.rerender(<CanvasFocusController />);
    expect(flow.fitView).not.toHaveBeenCalled();
    // Graph hydration can arrive before React Flow's final size measurement.
    act(() => { useGraphStore.setState({ nodes: [node('motion'), { ...node('sibling'), selected: true }] }); });
    flow.internalNodes.set('motion', { measured: { width: 280, height: 460 } });
    await act(async () => { view.rerender(<CanvasFocusController />); });
    expect(flow.fitView).toHaveBeenCalledExactlyOnceWith({
      nodes: [{ id: 'motion' }], maxZoom: 1, duration: 300,
      padding: { top: '40px', right: '40px', bottom: '40px', left: '40px' },
    });
    expect(useUIStore.getState().canvasFocusRequest).toBeNull();
    expect(useGraphStore.getState().nodes.filter(({ selected }) => selected).map(({ id }) => id)).toEqual(['motion']);
  });

  it('uses no animation for reduced motion', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    flow.initialized = true;
    flow.internalNodes.set('motion', { measured: { width: 280, height: 460 } });
    useUIStore.getState().requestCanvasNodeFocus('motion');
    await act(async () => { render(<CanvasFocusController />); });
    expect(flow.fitView.mock.calls[0][0].duration).toBe(0);
  });

  it('drops a deleted target instead of fitting another node or waiting indefinitely', () => {
    useUIStore.getState().requestCanvasNodeFocus('motion');
    render(<CanvasFocusController />);
    act(() => { useGraphStore.setState({ nodes: [node('sibling')] }); });
    expect(useUIStore.getState().canvasFocusRequest).toBeNull();
    expect(useUIStore.getState().selectedNodeId).toBeNull();
    expect(flow.fitView).not.toHaveBeenCalled();
  });

  it('only fits while Canvas is active', () => {
    flow.initialized = true;
    flow.internalNodes.set('motion', { measured: { width: 280, height: 460 } });
    useUIStore.getState().requestCanvasNodeFocus('motion');
    useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'scene' });
    render(<CanvasFocusController />);
    expect(flow.fitView).not.toHaveBeenCalled();
  });

  it('an older fit promise cannot clear a newer request', async () => {
    const first = deferred();
    const second = deferred();
    flow.fitView.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    flow.initialized = true;
    flow.internalNodes.set('motion', { measured: { width: 280, height: 460 } });
    flow.internalNodes.set('sibling', { measured: { width: 280, height: 460 } });
    useUIStore.getState().requestCanvasNodeFocus('motion');
    render(<CanvasFocusController />);
    act(() => { useUIStore.getState().requestCanvasNodeFocus('sibling'); });
    const newestRequest = useUIStore.getState().canvasFocusRequest!;
    await act(async () => { first.resolve(true); await first.promise; });
    expect(useUIStore.getState().canvasFocusRequest).toBe(newestRequest);
    await act(async () => { second.resolve(true); await second.promise; });
    expect(useUIStore.getState().canvasFocusRequest).toBeNull();
    expect(flow.fitView.mock.calls.map(([options]) => options.nodes)).toEqual([
      [{ id: 'motion' }], [{ id: 'sibling' }],
    ]);
  });

  it('does not start a duplicate fit when a measured node updates during animation', async () => {
    const fit = deferred();
    flow.fitView.mockReturnValue(fit.promise);
    flow.initialized = true;
    flow.internalNodes.set('motion', { measured: { width: 280, height: 460 } });
    useUIStore.getState().requestCanvasNodeFocus('motion');
    const view = render(<CanvasFocusController />);
    flow.internalNodes.set('motion', { measured: { width: 280, height: 500 } });
    view.rerender(<CanvasFocusController />);
    expect(flow.fitView).toHaveBeenCalledTimes(1);
    await act(async () => { fit.resolve(true); await fit.promise; });
  });

  it('does not reactivate the initial all-nodes fit after consuming a mounted handoff', async () => {
    flow.initialized = true;
    flow.internalNodes.set('motion', { measured: { width: 280, height: 460 } });
    useUIStore.getState().requestCanvasNodeFocus('motion');
    await act(async () => { render(<Canvas />); });
    expect(flow.fitProp).toBe(false);
    expect(useUIStore.getState().canvasFocusRequest).toBeNull();
    expect(flow.fitProp).toBe(false);
    expect(flow.fitView).toHaveBeenCalledTimes(1);
  });

  it('a delayed automatic fit yields even when explicit focus has already settled', async () => {
    flow.initialized = true;
    flow.internalNodes.set('motion', { measured: { width: 280, height: 460 } });
    render(<Canvas />);
    act(() => { window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', { detail: { totalCount: 2 } })); });
    await act(async () => { useUIStore.getState().requestCanvasNodeFocus('motion'); });
    expect(useUIStore.getState().canvasFocusRequest).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(flow.fitView).toHaveBeenCalledTimes(1);
    expect(flow.fitView.mock.calls[0][0].nodes).toEqual([{ id: 'motion' }]);
  });

  it('cancels automatic fit timers when leaving Canvas', async () => {
    const view = render(<Canvas />);
    act(() => { window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added')); });
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(flow.fitView).not.toHaveBeenCalled();
  });

  it('keeps ordinary node-added auto-fit through the accompanying node-count render', async () => {
    render(<Canvas />);
    act(() => {
      window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', { detail: { totalCount: 3 } }));
      useGraphStore.setState({ nodes: [node('motion'), node('sibling'), node('added')] });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(flow.fitView).toHaveBeenCalledTimes(1);
    expect(flow.fitView.mock.calls[0][0]).toMatchObject({ duration: 400, maxZoom: 0.85 });
    expect(flow.fitView.mock.calls[0][0].nodes).toBeUndefined();
  });
});
