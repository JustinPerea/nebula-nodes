import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { MoodboardImage, MoodboardPlacement } from '../../types';

// #209, GM (a): the Board view refits when its column resizes, only while the
// camera is still where the last whole-board fit left it. React Flow is a
// stand-in whose measured size (the board column) the test changes, and
// whose move callbacks the test calls as React Flow would: with a source
// event for the person's own moves, without one for the camera's.

type View = { x: number; y: number; zoom: number };
type FlowProps = {
  onMoveStart?: (event: unknown, viewport: unknown) => void;
  onMoveEnd?: (event: unknown, viewport: View) => void;
  onNodesChange?: (changes: unknown[]) => void;
  onNodeDragStop?: (event: unknown, node: unknown, nodes: unknown[]) => void;
  fitView?: boolean;
  defaultViewport?: View;
  children?: ReactNode;
};
const flow = vi.hoisted(() => {
  const listeners = new Set<(state: { width: number; height: number }, previous: { width: number; height: number }) => void>();
  const state = { width: 870, height: 851 };
  return {
    props: null as FlowProps | null,
    // As React Flow's does: the move starts inside the call, with no source event.
    setViewport: vi.fn((viewport: View) => { flow.props?.onMoveStart?.(null, viewport); }),
    state,
    listeners,
    resize(width: number, height: number) {
      const previous = { ...state };
      state.width = width;
      state.height = height;
      for (const listener of listeners) listener({ ...state }, previous);
    },
  };
});
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ReactFlow: (props: FlowProps) => { flow.props = props; return <div data-testid="flow">{props.children}</div>; },
  Background: () => null,
  useReactFlow: () => ({
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    setViewport: flow.setViewport,
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    getNodesBounds: () => ({ x: 0, y: 0, width: 2000, height: 1000 }),
  }),
  useStoreApi: () => ({
    getState: () => ({ ...flow.state }),
    subscribe: (listener: (s: { width: number; height: number }, p: { width: number; height: number }) => void) => {
      flow.listeners.add(listener);
      return () => flow.listeners.delete(listener);
    },
  }),
}));

import { getViewportForBounds } from '@xyflow/react';
import { BoardCanvas } from './BoardCanvas';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';

const card = (id: string, x: number): MoodboardPlacement => ({
  id, frameId: null, x, y: 0, w: 480, h: 270, weight: 1, placedBy: 'person', placedAt: '' });
const images: MoodboardImage[] = ['a', 'b', 'c'].map((id, index) => ({
  id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false, placements: [card(`c${id}`, index * 520)] }));

let frames: FrameRequestCallback[] = [];
let reduced = false;
const runFrames = () => act(() => {
  for (let i = 0; i < 400 && frames.length; i += 1) {
    const now = frames.splice(0);
    for (const cb of now) cb(performance.now() + i * 16);
  }
});
const mount = () => render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} />);
const resize = (width: number, height: number) => act(() => flow.resize(width, height));
/** Where the camera was last sent. */
const lastViewport = () => flow.setViewport.mock.calls.at(-1)?.[0] as { x: number; y: number; zoom: number } | undefined;
/** Run the frames waiting now (one spring step) at time `t`. */
const step = (t: number) => act(() => { frames.splice(0).forEach((cb) => cb(t)); });
/** The whole fit (not just its zoom) for the 2000 x 1000 board in a column this size. */
const fitViewport = (width: number, height: number) =>
  getViewportForBounds({ x: 0, y: 0, width: 2000, height: 1000 }, width, height, 0.02, 1, 0.12);
/** A card drag under way, as React Flow reports it. */
const dragCard = () => act(() => { flow.props!.onNodesChange!([{ type: 'position', id: 'ca', position: { x: 40, y: 0 }, dragging: true }]); });
const dropCard = () => act(() => { flow.props!.onNodeDragStop!(null, {}, [{ id: 'ca' }]); });
const fitButton = () => document.querySelector<HTMLButtonElement>('[aria-label="Fit the board"]')!;
/** The fit's zoom for the 2000 x 1000 board in a column this size (the fit padding, 0.12). */
const fitFor = (width: number, height: number) =>
  getViewportForBounds({ x: 0, y: 0, width: 2000, height: 1000 }, width, height, 0.02, 1, 0.12).zoom;

beforeEach(() => {
  flow.props = null;
  flow.setViewport.mockReset();
  flow.listeners.clear();
  flow.state.width = 870;
  flow.state.height = 851;
  frames = [];
  reduced = false;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames[id - 1] = () => {}; });
  window.matchMedia = ((query: string) => ({ matches: reduced && query.includes('reduce'), media: query,
    addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  useBoardCanvasStore.setState({ selection: {}, viewports: {}, fitted: {}, frameRequest: null });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('a fitted board follows its column', () => {
  it('fit on open, then the window narrows: it refits into the narrower column', () => {
    mount();
    expect(flow.props?.fitView).toBe(true);
    resize(430, 851);
    runFrames();
    expect(lastViewport()?.zoom).toBeCloseTo(fitFor(430, 851), 5);
  });

  it('the offline row opens (a shorter column) and closes: it refits each time', () => {
    flow.state.width = 430;
    mount();
    resize(430, 300);
    runFrames();
    expect(lastViewport()).toEqual(fitViewport(430, 300));
    resize(430, 851);
    runFrames();
    // The same zoom (the fit is width-bound at both heights), a new y: a second refit ran.
    expect(lastViewport()).toEqual(fitViewport(430, 851));
    expect(fitViewport(430, 851).y).not.toBeCloseTo(fitViewport(430, 300).y, 1);
  });

  it('the fit\'s own spring (moves with no source event) keeps it fitted', () => {
    mount();
    act(() => { fitButton().click(); });
    act(() => { flow.props!.onMoveStart!(null, { x: 0, y: 0, zoom: 0.3 }); });
    runFrames();
    resize(430, 851);
    runFrames();
    expect(lastViewport()?.zoom).toBeCloseTo(fitFor(430, 851), 5);
  });

  it('a pan or zoom by the person (a move with a source event) keeps their view through a resize', () => {
    mount();
    act(() => { flow.props!.onMoveStart!(new MouseEvent('mousedown'), { x: 0, y: 0, zoom: 1 }); });
    flow.setViewport.mockClear();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('the zoom buttons keep the view too', () => {
    mount();
    act(() => { document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click(); });
    runFrames();
    flow.setViewport.mockClear();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a pan, then Fit: fitted again, so the next resize refits', () => {
    mount();
    act(() => { flow.props!.onMoveStart!(new WheelEvent('wheel'), { x: 0, y: 0, zoom: 1 }); });
    act(() => { fitButton().click(); });
    runFrames();
    resize(430, 851);
    runFrames();
    expect(lastViewport()?.zoom).toBeCloseTo(fitFor(430, 851), 5);
  });

  it('an Update\'s Show frames its cards; a later resize keeps that framing', () => {
    mount();
    act(() => { useBoardCanvasStore.getState().requestFrame('k1', ['ca']); });
    runFrames();
    flow.setViewport.mockClear();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a resize to the same size, or several in one frame, refit at most once', () => {
    mount();
    resize(870, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    resize(800, 851);
    resize(700, 851);
    resize(430, 851);
    const springs = frames.length;
    expect(springs).toBe(1);
    runFrames();
    expect(lastViewport()?.zoom).toBeCloseTo(fitFor(430, 851), 5);
  });
});

describe('a camera kept from earlier in the visit', () => {
  it('kept while fitted, at another column size: it opens fitted to the column it has now, then follows it', () => {
    // Fitted at 1440 wide, then List, the window narrowed, back to Board (review 2, H).
    useBoardCanvasStore.setState({ viewports: { k1: { x: 46, y: 261.5, zoom: 0.319 } }, fitted: { k1: true } });
    flow.state.width = 430;
    mount();
    expect(flow.props?.fitView).toBe(true);
    expect(flow.props?.defaultViewport).toBeUndefined();
    resize(430, 300);
    runFrames();
    expect(lastViewport()).toEqual(fitViewport(430, 300));
  });

  it('kept after the person moved it: it opens exactly as kept, and a resize keeps it', () => {
    useBoardCanvasStore.setState({ viewports: { k1: { x: 1, y: 2, zoom: 0.3 } }, fitted: { k1: false } });
    mount();
    expect(flow.props?.fitView).toBe(false);
    expect(flow.props?.defaultViewport).toEqual({ x: 1, y: 2, zoom: 0.3 });
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    expect(useBoardCanvasStore.getState().viewports.k1).toEqual({ x: 1, y: 2, zoom: 0.3 });
  });

  it('closed mid-refit: React Flow\'s late move end does not keep the camera mid-spring; it reopens fitted', () => {
    const view = mount();
    resize(430, 851);
    step(0); // the coalesced refit starts its spring
    step(16); // one frame on the way
    const midway = lastViewport()!;
    expect(midway.zoom).not.toBeCloseTo(fitFor(430, 851), 5);
    const late = flow.props!.onMoveEnd!;
    view.unmount();
    act(() => { late(null, midway); }); // its 150 ms timer, after the view closed (review 2, H4)
    expect(useBoardCanvasStore.getState().viewports.k1).toEqual(fitViewport(430, 851));
    expect(useBoardCanvasStore.getState().fitted.k1).toBe(true);
    mount();
    expect(flow.props?.fitView).toBe(true);
  });

  it('closed mid-zoom: it reopens where the zoom was going, not fitted', () => {
    const view = mount();
    act(() => { document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click(); });
    step(16);
    const midway = lastViewport()!;
    const kept = { ...useBoardCanvasStore.getState().viewports.k1 };
    const late = flow.props!.onMoveEnd!;
    view.unmount();
    act(() => { late(null, midway); });
    expect(useBoardCanvasStore.getState().viewports.k1).toEqual(kept);
    expect(kept).not.toEqual(midway);
    mount();
    expect(flow.props?.fitView).toBe(false);
    expect(flow.props?.defaultViewport).toEqual(kept);
  });

  it('a spring that has landed: its move end keeps where it landed', () => {
    mount();
    act(() => { fitButton().click(); });
    runFrames();
    act(() => { flow.props!.onMoveEnd!(null, lastViewport()!); });
    expect(useBoardCanvasStore.getState().viewports.k1).toEqual(lastViewport());
    expect(useBoardCanvasStore.getState().fitted.k1).toBe(true);
  });

  it('is kept with its fitted state: the person\'s move saves not fitted, the camera\'s own keeps fitted', () => {
    mount();
    act(() => { flow.props!.onMoveEnd!(null, { x: 5, y: 5, zoom: 0.4 }); });
    expect(useBoardCanvasStore.getState().fitted.k1).toBe(true);
    act(() => { flow.props!.onMoveStart!(new MouseEvent('mousedown'), { x: 5, y: 5, zoom: 0.4 }); });
    act(() => { flow.props!.onMoveEnd!(new MouseEvent('mouseup'), { x: 9, y: 9, zoom: 0.4 }); });
    expect(useBoardCanvasStore.getState().fitted.k1).toBe(false);
    act(() => { fitButton().click(); });
    expect(useBoardCanvasStore.getState().fitted.k1).toBe(true);
  });
});

describe('the person takes the camera', () => {
  it('a pan during a refit spring stops the spring at once and leaves the board not fitted', () => {
    mount();
    resize(430, 851);
    step(0);
    step(16);
    act(() => { flow.props!.onMoveStart!(new WheelEvent('wheel'), lastViewport()); });
    flow.setViewport.mockClear();
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    act(() => { flow.props!.onMoveEnd!(new WheelEvent('wheel'), { x: 7, y: 8, zoom: 0.2 }); });
    expect(useBoardCanvasStore.getState().viewports.k1).toEqual({ x: 7, y: 8, zoom: 0.2 });
    expect(useBoardCanvasStore.getState().fitted.k1).toBe(false);
    resize(870, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a card dragged to the edge autopans the camera (a move with no source event): the view is kept', () => {
    mount();
    dragCard();
    act(() => { flow.props!.onMoveStart!(null, { x: -400, y: 0, zoom: 0.3 }); }); // React Flow's autopan
    dropCard();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a card drag that never moves the camera keeps the board fitted', () => {
    mount();
    dragCard();
    dropCard();
    resize(430, 851);
    runFrames();
    expect(lastViewport()).toEqual(fitViewport(430, 851));
  });

  it('a refit\'s own frames during a card drag are not an autopan', () => {
    mount();
    dragCard();
    resize(430, 851);
    runFrames();
    expect(lastViewport()).toEqual(fitViewport(430, 851));
    resize(430, 300);
    runFrames();
    expect(lastViewport()).toEqual(fitViewport(430, 300));
  });

  it('a refit still waiting when the view closes never runs', () => {
    const view = mount();
    resize(430, 851);
    view.unmount();
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });
});

describe('motion', () => {
  it('a refit springs: the camera reaches the fit over several frames', () => {
    mount();
    resize(430, 851);
    act(() => { frames.splice(0).forEach((cb) => cb(0)); }); // the coalesced refit
    expect(flow.setViewport).not.toHaveBeenCalled();
    act(() => { frames.splice(0).forEach((cb) => cb(16)); });
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    expect(lastViewport()?.zoom).not.toBeCloseTo(fitFor(430, 851), 5);
    runFrames();
    expect(lastViewport()?.zoom).toBeCloseTo(fitFor(430, 851), 5);
  });

  it('under reduced motion the refit lands at once', () => {
    reduced = true;
    mount();
    resize(430, 851);
    act(() => { frames.splice(0).forEach((cb) => cb(0)); }); // the coalesced refit
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    expect(lastViewport()?.zoom).toBeCloseTo(fitFor(430, 851), 5);
  });
});
