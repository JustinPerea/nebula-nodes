import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Viewport } from '@xyflow/react';

// The fit the canvas runs after an agent's nodes land is the canvas's own
// camera move: projectStore saves it along with the agent's edit instead of
// reading "Unsaved changes" and restarting the autosave debounce. The
// person's pan, zoom and scroll, and their toolbar zoom and Fit view (also
// programmatic), stay theirs (2026-10-20).

type MoveHandler = (event: MouseEvent | TouchEvent | null, viewport: Viewport) => void;
type FlowProps = { onMove?: MoveHandler; onMoveStart?: MoveHandler; onMoveEnd?: MoveHandler };
let flow: FlowProps = {};
const fitView = vi.fn(async () => true);
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    ReactFlow: (props: FlowProps) => { flow = props; return null; },
    useReactFlow: () => ({ ...actual.useReactFlow(), fitView }),
  };
});

vi.mock('../lib/canvasSelection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/canvasSelection')>()),
  publishCanvasSelection: vi.fn(async () => {}),
}));

import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './Canvas';
import { resetCanvasCameraForTests } from '../lib/canvasCameraOwner';
import { useGraphStore } from '../store/graphStore';
import { useUIStore } from '../store/uiStore';

const byCanvas = () => (useUIStore.getState() as { canvasViewportByCanvas?: boolean }).canvasViewportByCanvas === true;
const at = (x: number): Viewport => ({ x, y: 0, zoom: 1 });

beforeEach(() => {
  flow = {};
  fitView.mockClear();
  resetCanvasCameraForTests();
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  useGraphStore.setState({ nodes: [{ id: 'n1', type: 'model', position: { x: 0, y: 0 }, data: {} }] as never, edges: [] });
  // A project saved with a view: no first fit is queued, so every move here is a later one.
  useUIStore.setState({ viewMode: 'canvas', canvasViewport: { x: 5, y: 5, zoom: 1 }, canvasFocusRequest: null,
    canvasViewportInitial: undefined });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const mount = () => render(<ReactFlowProvider><Canvas /></ReactFlowProvider>);
function agentNodesLand(): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', { detail: { addedCount: 3, totalCount: 4 } }));
    vi.advanceTimersByTime(80);
  });
  expect(fitView).toHaveBeenCalledTimes(1);
}

describe('the camera moves the canvas makes itself', () => {
  it('its fit after an agent’s nodes land, every frame of it', () => {
    mount();
    agentNodesLand();
    act(() => flow.onMoveStart?.(null, at(5)));
    act(() => flow.onMove?.(null, at(-40)));
    expect(useUIStore.getState().canvasViewport).toEqual(at(-40));
    expect(byCanvas()).toBe(true);
    act(() => flow.onMove?.(null, at(-80)));
    expect(byCanvas()).toBe(true);
    act(() => flow.onMoveEnd?.(null, at(-80)));
  });

  it('not the person’s scroll during that fit', () => {
    mount();
    agentNodesLand();
    act(() => flow.onMoveStart?.(null, at(5)));
    act(() => flow.onMove?.(null, at(-40)));
    act(() => flow.onMove?.(new WheelEvent('wheel') as never, at(-60)));
    expect(byCanvas()).toBe(false);
  });

  it('not the person’s toolbar zoom, alone or interrupting the fit', () => {
    mount();
    act(() => { flow.onMoveStart?.(null, at(5)); flow.onMove?.(null, at(10)); flow.onMoveEnd?.(null, at(10)); });
    expect(byCanvas()).toBe(false);
    agentNodesLand();
    act(() => { flow.onMoveStart?.(null, at(10)); flow.onMove?.(null, at(-40)); });
    expect(byCanvas()).toBe(true);
    // The zoom button's transition interrupts the fit: d3 ends the fit, then starts the zoom.
    act(() => { flow.onMoveEnd?.(null, at(-40)); flow.onMoveStart?.(null, at(-40)); flow.onMove?.(null, at(-30)); });
    expect(byCanvas()).toBe(false);
  });

  // React Flow reports onMoveEnd on a timer after d3 ends a move (150 ms with
  // panOnScroll, @xyflow/system createPanZoomEndHandler), so the end of the
  // move before can arrive in the middle of the canvas's next one.
  it('a second batch’s fit stays the canvas’s own when the fit it interrupted reports its end late', () => {
    mount();
    agentNodesLand();
    act(() => { flow.onMoveStart?.(null, at(5)); flow.onMove?.(null, at(-40)); });
    // The agent's next batch lands: its fit interrupts the first.
    act(() => {
      window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', { detail: { addedCount: 2, totalCount: 6 } }));
      vi.advanceTimersByTime(80);
    });
    act(() => { flow.onMoveStart?.(null, at(-40)); flow.onMove?.(null, at(-60)); });
    expect(byCanvas()).toBe(true);
    act(() => { vi.advanceTimersByTime(150); flow.onMoveEnd?.(null, at(-40)); });
    act(() => flow.onMove?.(null, at(-90)));
    expect(useUIStore.getState().canvasViewport).toEqual(at(-90));
    expect(byCanvas()).toBe(true);
  });

  it('the canvas’s fit stays its own when the person’s scroll before it reports its end late', () => {
    mount();
    const wheel = new WheelEvent('wheel') as never;
    act(() => { flow.onMoveStart?.(wheel, at(5)); flow.onMove?.(wheel, at(20)); });
    agentNodesLand();
    act(() => { flow.onMoveStart?.(null, at(20)); flow.onMove?.(null, at(-10)); });
    act(() => { vi.advanceTimersByTime(150); flow.onMoveEnd?.(wheel, at(20)); });
    act(() => flow.onMove?.(null, at(-30)));
    expect(byCanvas()).toBe(true);
  });

  it('not a pan by the person', () => {
    mount();
    act(() => { flow.onMoveStart?.(new MouseEvent('mousedown'), at(5)); flow.onMove?.(new MouseEvent('mousemove'), at(20)); });
    expect(byCanvas()).toBe(false);
  });
});
