import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import type { MoodboardImage, MoodboardPlacement } from '../../types';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// #209, GM (a): the Board view refits when its column resizes, only while the
// camera is still where the last whole-board fit left it. React Flow is a
// stand-in with a camera, a measured size (the board column) the test
// changes, and move callbacks the test calls the way @xyflow 12.10.2 does:
// - setViewport moves the camera and calls onMoveStart and onMove inside the
//   call, with no source event; onMoveEnd comes later (a 150 ms timer), so
//   the test calls it;
// - a scroll pan's first wheel event calls only onMoveStart; after a burst of
//   exactly one event (one mouse notch) its flag sticks, and every later
//   scroll calls only onMove, then onMoveEnd (review 3, MEDIUM-1);
// - the autopan and the pan to a focused card move the camera with no source
//   event;
// - a drag's mousemove carries the pointer's travel from the press (d3 pans
//   the camera by it);
// - unlike React Flow, its store never resets when the view closes, and its
//   setViewport runs no move-end timer: BoardCanvas.unmount.test.tsx runs the
//   close on React Flow's real store (#213 review 1 NIT-5).

type View = { x: number; y: number; zoom: number };
type FlowProps = {
  onMoveStart?: (event: unknown, viewport: View) => void;
  onMove?: (event: unknown, viewport: View) => void;
  onMoveEnd?: (event: unknown, viewport: View) => void;
  onNodesChange?: (changes: unknown[]) => void;
  onNodeDragStop?: (event: unknown, node: unknown, nodes: unknown[]) => void;
  fitView?: boolean;
  defaultViewport?: View;
  children?: ReactNode;
};
const flow = vi.hoisted(() => {
  type Measured = { width: number; height: number; panZoom?: object | null };
  const listeners = new Set<(state: Measured, previous: Measured) => void>();
  const state = { width: 870, height: 851 };
  const camera = { x: 0, y: 0, zoom: 1 };
  return {
    props: null as FlowProps | null,
    camera,
    /** React Flow's d3 camera, which it makes after it may have measured the board. */
    panZoom: null as object | null,
    makesCamera: true,
    setViewport: vi.fn((viewport: View) => {
      Object.assign(flow.camera, viewport);
      flow.props?.onMoveStart?.(null, { ...flow.camera });
      flow.props?.onMove?.(null, { ...flow.camera });
    }),
    state,
    listeners,
    resize(width: number, height: number) {
      const previous = { ...state, panZoom: flow.panZoom };
      state.width = width;
      state.height = height;
      for (const listener of listeners) listener({ ...state, panZoom: flow.panZoom }, previous);
    },
    store: {
      getState: () => ({ ...state, panZoom: flow.panZoom, transform: [camera.x, camera.y, camera.zoom] }),
      subscribe: (listener: (s: Measured, p: Measured) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    cameraReady() {
      const previous = { ...state, panZoom: null };
      flow.panZoom = {};
      for (const listener of listeners) listener({ ...state, panZoom: flow.panZoom }, previous);
    },
  };
});
vi.mock('@xyflow/react', async (importOriginal) => {
  const { useEffect } = await import('react');
  return {
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ReactFlow: function ReactFlow(props: FlowProps) {
    flow.props = props;
    // As React Flow's ZoomPane: it makes its camera in an effect, at the
    // default viewport, and makes it again when React runs effects twice.
    useEffect(() => {
      if (!flow.makesCamera) return;
      flow.panZoom = {};
      Object.assign(flow.camera, props.defaultViewport ?? { x: 0, y: 0, zoom: 1 });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <div data-testid="flow">{props.children}</div>;
  },
  Background: () => null,
  useReactFlow: () => ({
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    setViewport: flow.setViewport,
    getViewport: () => ({ ...flow.camera }),
    // The whole board (2000 x 1000 for the three cards, wider when a card
    // sits further right: one added or moved there), or one card (an
    // Update's Show of it).
    getNodesBounds: (nodes: Array<{ position: { x: number } }>) => (nodes.length > 1
      ? { x: 0, y: 0, width: 2000 + Math.max(...nodes.map((node) => node.position.x)) - 1040, height: 1000 }
      : { x: 0, y: 0, width: 480, height: 270 }),
  }),
  // One store for the provider's life, as React Flow's is.
  useStoreApi: () => flow.store,
  };
});

import { getViewportForBounds } from '@xyflow/react';
import { BoardCanvas } from './BoardCanvas';
import { BOARD_BAR_BAND_PX } from '../../lib/boardViewInsets';
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
const mount = (list: MoodboardImage[] = images) =>
  render(<BoardCanvas boardKey="k1" images={list} onMove={() => {}} onDropFiles={() => {}} />);
/** Mounted and fit on open; the test watches the camera from here. */
const mounted = () => {
  const view = mount();
  flow.setViewport.mockClear();
  return view;
};
const resize = (width: number, height: number) => act(() => flow.resize(width, height));
/** Where the camera was last sent. */
const lastViewport = () => flow.setViewport.mock.calls.at(-1)?.[0] as View | undefined;
/** Run the frames waiting now (one spring step) at time `t`. */
const step = (t: number) => act(() => { frames.splice(0).forEach((cb) => cb(t)); });
/** The whole fit for the 2000 x 1000 board in a column this size, above the
 *  control bar's band (lib/boardViewInsets: jsdom has no layout to measure,
 *  so the band is BOARD_BAR_BAND_PX). */
const fitViewport = (width: number, height: number, boardWidth = 2000) =>
  getViewportForBounds({ x: 0, y: 0, width: boardWidth, height: 1000 }, width, height - BOARD_BAR_BAND_PX, 0.02, 1, 0.12);
const fitButton = () => document.querySelector<HTMLButtonElement>('[aria-label="Fit the board"]')!;
const press = (label: string) => act(() => { document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(); });
const wheel = () => new WheelEvent('wheel', { deltaY: 100 });
const camera = () => ({ ...flow.camera });
const kept = () => ({ viewport: useBoardCanvasStore.getState().viewports.k1, fitted: useBoardCanvasStore.getState().fitted.k1 });
/** One mouse-wheel notch: the camera moves, React Flow calls onMoveStart and never ends it. */
const notch = (dy = 50) => act(() => {
  flow.camera.y -= dy;
  flow.props!.onMoveStart!(wheel(), camera());
});
/** A scroll pan after a notch (React Flow's flag stuck): onMove for each event, then onMoveEnd. */
const stuckPan = (dx = 30, dy = 45, end = true) => act(() => {
  for (let i = 0; i < 4; i += 1) {
    flow.camera.x -= dx;
    flow.camera.y -= dy;
    flow.props!.onMove!(wheel(), camera());
  }
  if (end) flow.props!.onMoveEnd!(wheel(), camera());
});
/** A pan React Flow makes with no source event (the autopan, the pan to a focused card). */
const autopan = (to: View) => act(() => {
  flow.props!.onMoveStart!(null, camera());
  Object.assign(flow.camera, to);
  flow.props!.onMove!(null, camera());
  flow.props!.onMoveEnd!(null, camera());
});

beforeEach(() => {
  flow.props = null;
  flow.setViewport.mockReset();
  flow.listeners.clear();
  flow.state.width = 870;
  flow.state.height = 851;
  flow.panZoom = null;
  flow.makesCamera = true;
  Object.assign(flow.camera, { x: 0, y: 0, zoom: 1 });
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
  it('a fresh open is fit at once to its column, then refits into a narrower one', () => {
    mount();
    expect(flow.props?.fitView).toBeUndefined();
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    expect(camera()).toEqual(fitViewport(870, 851));
    expect(frames).toHaveLength(0);
    expect(kept()).toEqual({ viewport: fitViewport(870, 851), fitted: true });
    resize(430, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851));
  });

  it('mounted at 0 x 0 (laid out later): the first real size fits it', () => {
    flow.state.width = 0;
    flow.state.height = 0;
    mount();
    expect(flow.setViewport).not.toHaveBeenCalled();
    resize(870, 851);
    expect(camera()).toEqual(fitViewport(870, 851));
    resize(430, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851));
  });

  it('cards that load after the board mounts: the first of them gets the fit on open', () => {
    const view = mount([]);
    expect(flow.setViewport).not.toHaveBeenCalled();
    view.rerender(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} />);
    expect(camera()).toEqual(fitViewport(870, 851));
    expect(kept()).toEqual({ viewport: fitViewport(870, 851), fitted: true });
  });

  it('measured before React Flow has made its camera: the fit on open waits for the camera', () => {
    flow.makesCamera = false;
    mount();
    expect(flow.setViewport).not.toHaveBeenCalled();
    act(() => flow.cameraReady());
    expect(camera()).toEqual(fitViewport(870, 851));
  });

  it('React Flow makes its camera again (React runs effects twice in development): the fit is put back', () => {
    render(<StrictMode><BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} /></StrictMode>);
    expect(camera()).toEqual(fitViewport(870, 851));
    expect(kept()).toEqual({ viewport: fitViewport(870, 851), fitted: true });
  });

  it('React Flow makes its camera again while the column reads 0 x 0: the fit comes back when it is measured, even at the same size', () => {
    mounted();
    act(() => {
      const previous = { ...flow.state, panZoom: flow.panZoom };
      flow.state.width = 0;
      flow.state.height = 0;
      flow.panZoom = {};
      Object.assign(flow.camera, { x: 0, y: 0, zoom: 1 });
      for (const listener of flow.listeners) listener({ ...flow.state, panZoom: flow.panZoom }, previous);
    });
    expect(camera()).toEqual({ x: 0, y: 0, zoom: 1 });
    resize(870, 851);
    expect(camera()).toEqual(fitViewport(870, 851));
  });

  it('React Flow makes its camera again under a camera the person moved: their camera is put back', () => {
    mounted();
    act(() => {
      flow.camera.x -= 90;
      flow.props!.onMove!(wheel(), camera());
    });
    const moved = camera();
    act(() => {
      const previous = { ...flow.state, panZoom: flow.panZoom };
      flow.panZoom = {};
      Object.assign(flow.camera, { x: 0, y: 0, zoom: 1 });
      for (const listener of flow.listeners) listener({ ...flow.state, panZoom: flow.panZoom }, previous);
    });
    expect(camera()).toEqual(moved);
  });

  it('a person who moves the camera before the fit on open has happened keeps their view', () => {
    const view = mount([]);
    act(() => {
      flow.camera.x -= 90;
      flow.props!.onMove!(wheel(), camera());
    });
    view.rerender(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} />);
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('the offline row opens (a shorter column) and closes: it refits each time', () => {
    flow.state.width = 430;
    mounted();
    resize(430, 300);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 300));
    resize(430, 851);
    runFrames();
    // The same zoom (the fit is width-bound at both heights), a new y: a second refit ran.
    expect(camera()).toEqual(fitViewport(430, 851));
    expect(fitViewport(430, 851).y).not.toBeCloseTo(fitViewport(430, 300).y, 1);
  });

  it('the Fit button\'s spring keeps it fitted', () => {
    mounted();
    notch();
    act(() => { fitButton().click(); });
    runFrames();
    resize(430, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851));
  });

  it('a pan by the person keeps their view through a resize', () => {
    mounted();
    act(() => {
      flow.props!.onMoveStart!(new MouseEvent('mousedown'), camera());
      flow.camera.x += 120;
      flow.props!.onMove!(new MouseEvent('mousemove', { clientX: 120 }), camera());
    });
    flow.setViewport.mockClear();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('the zoom buttons keep the view too', () => {
    mounted();
    press('Zoom in');
    runFrames();
    flow.setViewport.mockClear();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('an Update\'s Show frames its cards; a later resize keeps that framing', () => {
    mounted();
    act(() => { useBoardCanvasStore.getState().requestFrame('k1', ['ca']); });
    runFrames();
    flow.setViewport.mockClear();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a resize to the same size, or several in one frame, refit at most once', () => {
    mounted();
    resize(870, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    resize(800, 851);
    resize(700, 851);
    resize(430, 851);
    expect(frames).toHaveLength(1);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851));
  });

  it('Fit on an empty board does nothing', () => {
    mount([]);
    act(() => { fitButton().click(); });
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    expect(kept().viewport).toBeUndefined();
  });
});

describe('fitted is read from the camera (review 3, MEDIUM-1)', () => {
  it('one wheel notch, Fit, then a scroll pan React Flow reports only through onMove: the pan is kept through a resize', () => {
    mounted();
    notch();
    act(() => { fitButton().click(); });
    runFrames();
    stuckPan();
    const panned = camera();
    expect(kept()).toEqual({ viewport: panned, fitted: false });
    flow.setViewport.mockClear();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    expect(camera()).toEqual(panned);
  });

  it('the same, then List and back: it reopens where the person left it', () => {
    const view = mounted();
    notch();
    act(() => { fitButton().click(); });
    runFrames();
    stuckPan(30, 45, false); // and no move end at all
    const panned = camera();
    view.unmount();
    flow.setViewport.mockClear();
    mount();
    expect(flow.props?.defaultViewport).toEqual(panned);
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a stuck-flag pan 40 ms into a refit spring stops the spring and keeps the pan (C3)', () => {
    mounted();
    notch();
    act(() => { fitButton().click(); });
    runFrames();
    resize(430, 851);
    step(0); // the coalesced refit starts its spring
    step(16);
    step(32);
    stuckPan();
    const panned = camera();
    flow.setViewport.mockClear();
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    expect(camera()).toEqual(panned);
    expect(kept()).toEqual({ viewport: panned, fitted: false });
    resize(430, 300);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('onMove with a source event and no onMoveStart stops a running fit spring and unfits', () => {
    mounted();
    resize(430, 851);
    step(0);
    step(16);
    act(() => {
      flow.camera.x -= 80;
      flow.props!.onMove!(wheel(), camera());
    });
    const panned = camera();
    flow.setViewport.mockClear();
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    act(() => { flow.props!.onMoveEnd!(wheel(), camera()); }); // its end, 150 ms on
    expect(kept()).toEqual({ viewport: panned, fitted: false });
  });

  it('a pan to a card focused from the keyboard (no source event, no drag) unfits', () => {
    mounted();
    autopan({ x: -900, y: 120, zoom: fitViewport(870, 851).zoom });
    expect(kept().fitted).toBe(false);
    flow.setViewport.mockClear();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a card dragged to the edge autopans the camera: the view is kept', () => {
    mounted();
    act(() => { flow.props!.onNodesChange!([{ type: 'position', id: 'ca', position: { x: 40, y: 0 }, dragging: true }]); });
    autopan({ ...fitViewport(870, 851), x: -400 });
    act(() => { flow.props!.onNodeDragStop!(null, {}, [{ id: 'ca' }]); });
    flow.setViewport.mockClear();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a person who pans back exactly onto the fit has a fitted board again', () => {
    mounted();
    notch(50);
    expect(kept().fitted).toBe(false);
    act(() => {
      flow.camera.y += 50;
      flow.props!.onMove!(wheel(), camera());
      flow.props!.onMoveEnd!(wheel(), camera());
    });
    expect(kept().fitted).toBe(true);
    resize(430, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851));
  });
});

describe('a camera kept from earlier in the visit', () => {
  it('kept while fitted, at another column size: it opens fitted to the column it has now, then follows it', () => {
    // Fitted at 1440 wide, then List, the window narrowed, back to Board (review 2, H).
    useBoardCanvasStore.setState({ viewports: { k1: { x: 46, y: 261.5, zoom: 0.319 } }, fitted: { k1: true } });
    flow.state.width = 430;
    mount();
    expect(flow.props?.defaultViewport).toBeUndefined();
    expect(camera()).toEqual(fitViewport(430, 851));
    resize(430, 300);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 300));
  });

  it('kept after the person moved it: it opens exactly as kept, and a resize keeps it', () => {
    useBoardCanvasStore.setState({ viewports: { k1: { x: 1, y: 2, zoom: 0.3 } }, fitted: { k1: false } });
    mount();
    expect(flow.props?.defaultViewport).toEqual({ x: 1, y: 2, zoom: 0.3 });
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    expect(kept().viewport).toEqual({ x: 1, y: 2, zoom: 0.3 });
  });

  it('closed mid-refit: React Flow\'s late move end does not keep the camera mid-spring; it reopens fitted', () => {
    const view = mounted();
    resize(430, 851);
    step(0);
    step(16);
    const midway = lastViewport()!;
    expect(midway.zoom).not.toBeCloseTo(fitViewport(430, 851).zoom, 5);
    const late = flow.props!.onMoveEnd!;
    view.unmount();
    act(() => { late(null, midway); }); // its 150 ms timer, after the view closed (review 2, H4)
    expect(kept()).toEqual({ viewport: fitViewport(430, 851), fitted: true });
  });

  it('closed mid-spring: the spring stops, so the camera isn\'t moved after the view closed', () => {
    const view = mounted();
    resize(430, 851);
    step(0);
    step(16);
    view.unmount();
    flow.setViewport.mockClear();
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('closed mid-zoom: it reopens where the zoom was going, not fitted', () => {
    const view = mounted();
    press('Zoom in');
    step(16);
    const midway = lastViewport()!;
    const target = { ...kept().viewport! };
    const late = flow.props!.onMoveEnd!;
    view.unmount();
    act(() => { late(null, midway); });
    expect(kept()).toEqual({ viewport: target, fitted: false });
    expect(target).not.toEqual(midway);
    mount();
    expect(flow.props?.defaultViewport).toEqual(target);
  });

  it('a notch during a spring, then the spring\'s stale move end: the store keeps the camera, not the spring frame (LOW-2)', () => {
    mounted();
    press('Zoom in');
    step(16);
    const frame = lastViewport()!;
    notch(); // stops the spring; React Flow never ends this one
    const after = camera();
    act(() => { flow.props!.onMoveEnd!(null, frame); }); // the last spring frame's 150 ms timer
    expect(kept()).toEqual({ viewport: after, fitted: false });
  });

  it('a spring that has landed: its move end keeps where it landed', () => {
    mounted();
    notch();
    act(() => { fitButton().click(); });
    runFrames();
    act(() => { flow.props!.onMoveEnd!(null, camera()); });
    expect(kept()).toEqual({ viewport: fitViewport(870, 851), fitted: true });
  });

  it('under reduced motion a spring lands at once, and a later move end is kept', () => {
    reduced = true;
    mounted();
    press('Zoom in');
    Object.assign(flow.camera, { x: 5, y: 6, zoom: 0.5 });
    act(() => { flow.props!.onMoveEnd!(null, camera()); });
    expect(kept()).toEqual({ viewport: { x: 5, y: 6, zoom: 0.5 }, fitted: false });
  });
});

describe('the person takes the camera', () => {
  it('a pan during a refit spring stops the spring at once and leaves the board not fitted', () => {
    mounted();
    resize(430, 851);
    step(0);
    step(16);
    act(() => {
      // A scroll pan's first event: React Flow moves the camera, then calls onMoveStart.
      flow.camera.x -= 60;
      flow.props!.onMoveStart!(wheel(), camera());
    });
    flow.setViewport.mockClear();
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    act(() => { flow.props!.onMoveEnd!(wheel(), camera()); });
    expect(kept().fitted).toBe(false);
    resize(870, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a drag pan during a refit spring: the press moves nothing, the first frame that moves the camera stops the spring', () => {
    mounted();
    resize(430, 851);
    step(0);
    step(16);
    act(() => { flow.props!.onMoveStart!(new MouseEvent('mousedown', { button: 2 }), camera()); });
    step(32); // the press alone moved nothing: the spring still runs
    expect(flow.setViewport).toHaveBeenCalledTimes(2);
    act(() => {
      flow.camera.x -= 60;
      flow.props!.onMove!(new MouseEvent('mousemove', { buttons: 2, clientX: -60 }), camera());
    });
    const panned = camera();
    flow.setViewport.mockClear();
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    act(() => { flow.props!.onMoveEnd!(new MouseEvent('mouseup', { button: 2 }), camera()); });
    expect(kept()).toEqual({ viewport: panned, fitted: false });
  });

  it('a card drag that never moves the camera keeps the board fitted', () => {
    mounted();
    act(() => { flow.props!.onNodesChange!([{ type: 'position', id: 'ca', position: { x: 40, y: 0 }, dragging: true }]); });
    act(() => { flow.props!.onNodeDragStop!(null, {}, [{ id: 'ca' }]); });
    resize(430, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851));
  });

  it('a refit still waiting when the view closes never runs', () => {
    const view = mounted();
    resize(430, 851);
    view.unmount();
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });
});

// #209 review 4 LOW-1 (GM): d3 calls React Flow's onMoveStart on the press
// of a right or middle button, or of the left with Space held, before any
// pan. A press with no drag moves nothing, so the refit carries on to the fit.
describe('a press with no pan (review 4 LOW-1)', () => {
  const presses: Array<[string, () => MouseEvent]> = [
    ['a right press', () => new MouseEvent('mousedown', { button: 2 })],
    ['a middle press', () => new MouseEvent('mousedown', { button: 1 })],
    ['Space+click', () => new MouseEvent('mousedown', { button: 0 })],
  ];
  for (const [name, press] of presses) {
    it(`${name} during a refit spring, released without a drag: the refit lands on the fit`, () => {
      mounted();
      resize(430, 851);
      step(0);
      step(16);
      act(() => { flow.props!.onMoveStart!(press(), camera()); });
      const before = camera();
      step(32);
      expect(camera()).not.toEqual(before); // still springing
      act(() => { flow.props!.onMoveEnd!(new MouseEvent('mouseup'), camera()); });
      runFrames();
      expect(camera()).toEqual(fitViewport(430, 851));
      expect(kept()).toEqual({ viewport: fitViewport(430, 851), fitted: true });
      resize(870, 851);
      runFrames();
      expect(camera()).toEqual(fitViewport(870, 851));
    });

    it(`${name} at rest leaves the board fitted`, () => {
      mounted();
      act(() => { flow.props!.onMoveStart!(press(), camera()); });
      act(() => { flow.props!.onMoveEnd!(new MouseEvent('mouseup'), camera()); });
      expect(kept()).toEqual({ viewport: fitViewport(870, 851), fitted: true });
      resize(430, 851);
      runFrames();
      expect(camera()).toEqual(fitViewport(430, 851));
    });
  }
});

// GM, review 4 question 2: landing on the exact fit by any route counts as fitted.
describe('the zoom buttons', () => {
  it('zoom in, then back out: back on the fit, the board is fitted, refits and is kept fitted', () => {
    mounted();
    press('Zoom in');
    runFrames();
    expect(kept().fitted).toBe(false);
    press('Zoom out');
    runFrames();
    const fit = fitViewport(870, 851);
    expect(camera().zoom).toBeCloseTo(fit.zoom, 9);
    expect(camera().x).toBeCloseTo(fit.x, 6);
    expect(camera().y).toBeCloseTo(fit.y, 6);
    expect(kept().fitted).toBe(true);
    resize(430, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851));
  });

  it('zoom out, then back in, then List and back: it reopens fitted to the column it has then', () => {
    const view = mounted();
    press('Zoom out');
    runFrames();
    press('Zoom in');
    runFrames();
    view.unmount();
    flow.state.width = 430;
    mount();
    expect(flow.props?.defaultViewport).toBeUndefined();
    expect(camera()).toEqual(fitViewport(430, 851));
  });

  it('zoom in twice and out once is not on the fit: a resize keeps the view', () => {
    mounted();
    press('Zoom in');
    runFrames();
    press('Zoom in');
    runFrames();
    press('Zoom out');
    runFrames();
    expect(kept().fitted).toBe(false);
    flow.setViewport.mockClear();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });
});

// #209 review 4 NIT-3: the kept camera is written once a gesture, not each frame.
describe('keeping the camera for the visit', () => {
  const writes = () => {
    let count = 0;
    const stop = useBoardCanvasStore.subscribe((state, previous) => { if (state.viewports !== previous.viewports) count += 1; });
    return { count: () => count, stop };
  };

  it('a drag pan writes it once, when it ends', () => {
    mounted();
    const w = writes();
    act(() => { flow.props!.onMoveStart!(new MouseEvent('mousedown', { button: 1 }), camera()); });
    act(() => {
      for (let i = 0; i < 12; i += 1) {
        flow.camera.x -= 10;
        flow.props!.onMove!(new MouseEvent('mousemove', { buttons: 4, clientX: -10 * (i + 1) }), camera());
      }
    });
    expect(w.count()).toBe(0);
    act(() => { flow.props!.onMoveEnd!(new MouseEvent('mouseup', { button: 1 }), camera()); });
    expect(w.count()).toBe(1);
    expect(kept()).toEqual({ viewport: camera(), fitted: false });
    w.stop();
  });

  it('a press with no pan on a camera reopened where the person left it writes nothing', () => {
    useBoardCanvasStore.setState({ viewports: { k1: { x: 1, y: 2, zoom: 0.3 } }, fitted: { k1: false } });
    mount();
    const w = writes();
    act(() => { flow.props!.onMoveStart!(new MouseEvent('mousedown', { button: 2 }), camera()); });
    expect(w.count()).toBe(0);
    w.stop();
  });

  it('a scroll pan writes it at its first event (a lone notch never ends) and at its end, not in between', () => {
    mounted();
    const w = writes();
    notch();
    expect(w.count()).toBe(1);
    expect(kept()).toEqual({ viewport: camera(), fitted: false });
    stuckPan(30, 45, false);
    expect(w.count()).toBe(1);
    act(() => { flow.props!.onMoveEnd!(wheel(), camera()); });
    expect(w.count()).toBe(2);
    expect(kept()).toEqual({ viewport: camera(), fitted: false });
    w.stop();
  });
});

describe('motion', () => {
  it('a refit springs: the camera reaches the fit over several frames', () => {
    mounted();
    resize(430, 851);
    step(0); // the coalesced refit
    expect(flow.setViewport).not.toHaveBeenCalled();
    step(16);
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    expect(lastViewport()?.zoom).not.toBeCloseTo(fitViewport(430, 851).zoom, 5);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851));
  });

  it('under reduced motion the refit lands at once', () => {
    reduced = true;
    mounted();
    resize(430, 851);
    step(0); // the coalesced refit
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    expect(camera()).toEqual(fitViewport(430, 851));
  });
});

// #213 review 1 LOW-1 (GM: the board's own click distance). d3 puts the
// pressed board point back under the pointer on every mousemove, even a 1 px
// jitter, so mid-spring a jitter moves the camera back toward the press.
describe('a press that jitters within the click distance (#213 review 1 LOW-1)', () => {
  /** The camera d3 would make for a mousemove `dx` from the press: the pressed point back under the pointer. */
  const snap = (pressedAt: View, dx: number, dy = 0) => act(() => {
    Object.assign(flow.camera, { x: pressedAt.x + dx, y: pressedAt.y + dy, zoom: camera().zoom });
    flow.props!.onMove!(new MouseEvent('mousemove', { buttons: 4, clientX: 300 + dx, clientY: 200 + dy }), camera());
  });
  const pressMiddle = () => act(() => {
    flow.props!.onMoveStart!(new MouseEvent('mousedown', { button: 1, clientX: 300, clientY: 200 }), camera());
  });

  it('1 px of jitter during a refit spring: the camera stays on the spring, and the refit lands on the fit', () => {
    mounted();
    resize(430, 851);
    step(0);
    step(16);
    const pressedAt = camera();
    pressMiddle();
    step(32);
    const onSpring = camera();
    snap(pressedAt, 1);
    expect(camera()).toEqual(onSpring); // put straight back
    snap(pressedAt, 0, -1); // exactly 1 px away
    snap(pressedAt, 0.6, 0.7);
    expect(camera()).toEqual(onSpring);
    act(() => { flow.props!.onMoveEnd!(new MouseEvent('mouseup', { button: 1 }), camera()); });
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851));
    expect(kept()).toEqual({ viewport: fitViewport(430, 851), fitted: true });
    resize(870, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(870, 851));
  });

  it('past the click distance it is a drag: the spring stops and the board is not fitted', () => {
    mounted();
    resize(430, 851);
    step(0);
    step(16);
    const pressedAt = camera();
    pressMiddle();
    step(32);
    snap(pressedAt, 1, 0.1); // just over 1 px
    const dragged = camera();
    flow.setViewport.mockClear();
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    // Back inside the click distance later in the same drag is still the drag.
    snap(pressedAt, 0.5);
    expect(camera()).not.toEqual(dragged);
    act(() => { flow.props!.onMoveEnd!(new MouseEvent('mouseup', { button: 1 }), camera()); });
    expect(kept().fitted).toBe(false);
  });

  it('1 px of jitter at rest on the fit leaves the camera and the board fitted', () => {
    mounted();
    const fit = camera();
    pressMiddle();
    snap(fit, -1);
    expect(camera()).toEqual(fit);
    act(() => { flow.props!.onMoveEnd!(new MouseEvent('mouseup', { button: 1 }), camera()); });
    expect(kept()).toEqual({ viewport: fit, fitted: true });
  });

  it('a pinch at the press point while the press is held is a zoom, not jitter (review 2 R5)', () => {
    mounted();
    const fit = camera();
    pressMiddle();
    act(() => {
      Object.assign(flow.camera, { x: fit.x - 10, y: fit.y - 6, zoom: fit.zoom * 1.1 });
      flow.props!.onMove!(new WheelEvent('wheel', { ctrlKey: true, deltaY: -20, clientX: 300, clientY: 200 }), camera());
    });
    expect(camera().zoom).toBeCloseTo(fit.zoom * 1.1, 10);
    act(() => { flow.props!.onMoveEnd!(new MouseEvent('mouseup', { button: 1 }), camera()); });
    expect(kept().fitted).toBe(false);
  });

  it('the click distance is React Flow\'s pane click distance, passed to it', async () => {
    const { PANE_CLICK_DISTANCE } = await import('./BoardCanvas');
    mounted();
    expect(PANE_CLICK_DISTANCE).toBe(1);
    expect((flow.props as { paneClickDistance?: number }).paneClickDistance).toBe(PANE_CLICK_DISTANCE);
  });
});

// GM, #213 round 3: fitted means the camera is on the fit of the layout the
// board has now, however it got there; a spring that lands on the fit is a fit.
describe('on the fit of the layout the board has now (GM, #213 round 3)', () => {
  it('a zoom-out spring that lands on the fit, with a resize while it runs: it follows the resize (review 1 LOW-2)', () => {
    mounted();
    press('Zoom in');
    runFrames();
    press('Zoom out');
    expect(kept().fitted).toBe(true);
    step(0);
    step(16);
    resize(430, 851);
    const before = camera();
    step(32); // one spring frame, then the refit frame: the camera is mid-spring when it is judged
    expect(camera()).not.toEqual(before);
    expect(camera()).not.toEqual(fitViewport(870, 851));
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851));
    expect(kept()).toEqual({ viewport: fitViewport(430, 851), fitted: true });
  });

  it('a Show of every card after a resize while not fitted lands on the new column\'s fit: fitted, and it follows the next resize', () => {
    mounted();
    stuckPan();
    resize(430, 851);
    runFrames();
    expect(kept().fitted).toBe(false);
    act(() => { useBoardCanvasStore.getState().requestFrame('k1', ['ca', 'cb', 'cc']); });
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851));
    expect(kept()).toEqual({ viewport: fitViewport(430, 851), fitted: true });
    resize(870, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(870, 851));
  });

  it('a Show of every card, with a resize while it runs: it follows the resize', () => {
    mounted();
    stuckPan();
    act(() => { useBoardCanvasStore.getState().requestFrame('k1', ['ca', 'cb', 'cc']); });
    step(0);
    step(16);
    resize(430, 851);
    step(32); // the camera is mid-spring when the refit frame judges it
    expect(camera()).not.toEqual(fitViewport(870, 851));
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851));
  });

  // The rounding edges: a camera moved there by anything (here an autopan).
  const edges: Array<[string, Partial<View>, boolean]> = [
    ['x 0.5 px off', { x: 0.5 }, true],
    ['x 0.51 px off', { x: -0.51 }, false],
    ['y 0.5 px off', { y: -0.5 }, true],
    ['y 0.51 px off', { y: 0.51 }, false],
    ['zoom 0.09% off', { zoom: 0.0009 }, true],
    ['zoom 0.11% off', { zoom: -0.0011 }, false],
  ];
  for (const [name, off, fitted] of edges) {
    it(`a camera ${name} the fit is ${fitted ? '' : 'not '}fitted`, () => {
      mounted();
      const fit = fitViewport(870, 851);
      autopan({ x: fit.x + (off.x ?? 0), y: fit.y + (off.y ?? 0), zoom: fit.zoom * (1 + (off.zoom ?? 0)) });
      expect(kept().fitted).toBe(fitted);
      flow.setViewport.mockClear();
      resize(430, 851);
      runFrames();
      if (fitted) expect(camera()).toEqual(fitViewport(430, 851));
      else expect(flow.setViewport).not.toHaveBeenCalled();
    });
  }

  it('the fit clears the control bar\'s band: the fitted cards end above it (lib/boardViewInsets)', () => {
    mounted();
    const { y, zoom } = camera();
    // Centred in the column above the band, not in the whole column.
    expect(y + 500 * zoom).toBeCloseTo((851 - BOARD_BAR_BAND_PX) / 2, 6);
    expect(y + 1000 * zoom).toBeLessThan(851 - BOARD_BAR_BAND_PX);
    // A short column, where the height decides the zoom: the bottom row ends
    // within the fit's padding above the band, not under it.
    resize(870, 300);
    runFrames();
    const short = camera();
    const room = 300 - BOARD_BAR_BAND_PX;
    expect(short.y + 1000 * short.zoom).toBeLessThan(room);
    expect(short.y + 1000 * short.zoom).toBeGreaterThan(room - 0.12 * room);
  });
});

// #210 round 6q (GM r95): at 1024 x 640 with the offline row up, a three-line
// project line ran over the fitted card: the refit after the row opened
// centred the cards in the shorter column, under the line. The notice stack's
// band is outside the view (lib/boardViewInsets), measured at each fit.
describe('the fit clears the Studio\'s notices (GM r95)', () => {
  type Box = { top: number; height: number };
  const boxes = { board: { top: 49, height: 591 } as Box, stack: { top: 61, height: 62 } as Box };
  const rectOf = ({ top, height }: Box) => ({ top, bottom: top + height, height, left: 0, right: 870, width: 870, x: 0, y: top,
    toJSON: () => ({}) }) as DOMRect;
  let stackEl: HTMLDivElement;
  beforeEach(() => {
    stackEl = document.createElement('div');
    boxes.board = { top: 49, height: 591 };
    boxes.stack = { top: 61, height: 62 };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === stackEl) return rectOf(boxes.stack);
      if (this.classList.contains('moodboard-board')) return rectOf(boxes.board);
      if (this.classList.contains('moodboard-board__controls')) return rectOf({ top: boxes.board.top + boxes.board.height - 53, height: 38 });
      return rectOf({ top: 0, height: 0 });
    });
  });
  // The bar is measured here, so it publishes its clearance (lib/bottomBar), whose two-frame switch mark is
  // module state: run it out before the next test's frames start again from id 1.
  afterEach(() => { cleanup(); runFrames(); vi.restoreAllMocks(); });
  const mountWithNotices = () => {
    flow.state.width = 870;
    flow.state.height = boxes.board.height;
    return render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} notices={{ current: stackEl }} />);
  };
  /** Where the cards (the board's top row is at y 0) start, in the column, and where the notice band ends. */
  const cardsTop = () => camera().y;
  const bandEnd = () => boxes.stack.top + boxes.stack.height - boxes.board.top + 12;

  it('the fit on open frames the cards below a line that shows', () => {
    mountWithNotices();
    expect(cardsTop()).toBeGreaterThanOrEqual(bandEnd() - 0.5);
    expect(camera().y + 1000 * camera().zoom).toBeLessThanOrEqual(boxes.board.height - 53 + 0.5);
  });

  it('GM r95\'s case: the offline row opens (the column 49 px shorter): the refit keeps the cards below the line', () => {
    mountWithNotices();
    act(() => {
      boxes.board = { top: 98, height: 542 };
      boxes.stack = { top: 110, height: 62 };
    });
    resize(870, 542);
    runFrames();
    expect(bandEnd()).toBe(86);
    expect(cardsTop()).toBeGreaterThanOrEqual(86 - 0.5);
    expect(camera().y + 1000 * camera().zoom).toBeLessThanOrEqual(542 - 53 + 0.5);
  });

  it('the Studio hands the board its notice stack', () => {
    const studio = readFileSync(resolve(__dirname, 'MoodboardStudioView.tsx'), 'utf8');
    expect(studio).toMatch(/<div ref=\{noticesRef\} className="moodboard-studio-view__board-notices">\{notices\}<\/div>/);
    expect(studio).toMatch(/<BoardCanvas [^>]*\bnotices=\{noticesRef\}/);
  });
});

// #210 round 6r (GM r101): one flag, "view is fitted", set by every fit,
// refit and Show and cleared by any pan or zoom the person makes. While it is
// set, a notice line appearing or going frames the same cards again in the new
// view insets, on the board's spring (a jump under reduced motion); once
// cleared, #213 round 3 holds: a line never moves the camera.
describe('a line over a fitted view (GM r101)', () => {
  type Box = { top: number; height: number };
  const boxes = { board: { top: 49, height: 591 } as Box, stack: { top: 61, height: 0 } as Box };
  const rectOf = ({ top, height }: Box) => ({ top, bottom: top + height, height, left: 0, right: 870, width: 870, x: 0, y: top,
    toJSON: () => ({}) }) as DOMRect;
  let stackEl: HTMLDivElement;
  // The ResizeObservers watching the stack, as the browser's: each change of its size calls them.
  let watching: Array<{ cb: ResizeObserverCallback; targets: Set<Element> }>;
  beforeEach(() => {
    stackEl = document.createElement('div');
    boxes.board = { top: 49, height: 591 };
    boxes.stack = { top: 61, height: 0 };
    watching = [];
    vi.stubGlobal('ResizeObserver', class {
      entry: { cb: ResizeObserverCallback; targets: Set<Element> };
      constructor(cb: ResizeObserverCallback) {
        this.entry = { cb, targets: new Set() };
        watching.push(this.entry);
      }
      observe(target: Element) { this.entry.targets.add(target); }
      unobserve(target: Element) { this.entry.targets.delete(target); }
      disconnect() { this.entry.targets.clear(); }
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this === stackEl) return rectOf(boxes.stack);
      if (this.classList.contains('moodboard-board')) return rectOf(boxes.board);
      if (this.classList.contains('moodboard-board__controls')) return rectOf({ top: boxes.board.top + boxes.board.height - 53, height: 38 });
      return rectOf({ top: 0, height: 0 });
    });
  });
  afterEach(() => { cleanup(); runFrames(); vi.restoreAllMocks(); });
  const ui = (list: MoodboardImage[] = images) =>
    <BoardCanvas boardKey="k1" images={list} onMove={() => {}} onDropFiles={() => {}} notices={{ current: stackEl }} />;
  /** Mounted with no line showing, fit on open; the test watches the camera from here. */
  const open = () => {
    flow.state.width = 870;
    flow.state.height = boxes.board.height;
    const view = render(ui());
    flow.setViewport.mockClear();
    return view;
  };
  /** The stack changes size: a line `height` tall shows (0: it goes). */
  const line = (height: number) => act(() => {
    boxes.stack = { top: boxes.stack.top, height };
    for (const { cb, targets } of watching) if (targets.has(stackEl)) cb([], {} as ResizeObserver);
  });
  const bandEnd = () => boxes.stack.top + boxes.stack.height - boxes.board.top + 12;
  /** The whole-board fit inside the band and above the bar. */
  const fitBelowLine = (boardWidth = 2000) => {
    const top = boxes.stack.height > 0 ? bandEnd() : 0;
    const to = getViewportForBounds({ x: 0, y: 0, width: boardWidth, height: 1000 }, 870, boxes.board.height - top - 53, 0.02, 1, 0.12);
    return { x: to.x, y: to.y + top, zoom: to.zoom };
  };
  const expectClose = (at: View, to: View) => {
    expect(at.x).toBeCloseTo(to.x, 6);
    expect(at.y).toBeCloseTo(to.y, 6);
    expect(at.zoom).toBeCloseTo(to.zoom, 9);
  };
  const dragPan = () => act(() => {
    flow.props!.onMoveStart!(new MouseEvent('mousedown', { clientX: 0, clientY: 0 }), camera());
    flow.camera.x += 120;
    flow.props!.onMove!(new MouseEvent('mousemove', { clientX: 120, clientY: 0 }), camera());
    flow.props!.onMoveEnd!(new MouseEvent('mouseup'), camera());
  });
  const pinch = () => act(() => {
    flow.camera.zoom *= 1.1;
    flow.props!.onMoveStart!(new WheelEvent('wheel', { deltaY: -10, ctrlKey: true }), camera());
    flow.props!.onMoveEnd!(new WheelEvent('wheel', { deltaY: -10, ctrlKey: true }), camera());
  });
  const keyboardPan = () => autopan({ ...camera(), x: camera().x - 200 });

  it('fitted, a line appears: the cards spring clear of it; it goes: they spring back to the fit without it', () => {
    open();
    const before = camera();
    expect(before.y).toBeLessThan(bandEnd() + 62);
    line(62);
    expect(flow.setViewport).not.toHaveBeenCalled(); // on the spring, not a jump
    runFrames();
    expect(flow.setViewport.mock.calls.length).toBeGreaterThan(2);
    expectClose(camera(), fitBelowLine());
    expect(camera().y).toBeGreaterThanOrEqual(bandEnd() - 0.5);
    expect(camera().y + 1000 * camera().zoom).toBeLessThanOrEqual(boxes.board.height - 53 + 0.5);
    expect(kept().fitted).toBe(true);
    flow.setViewport.mockClear();
    line(0);
    runFrames();
    expectClose(camera(), before);
    expect(kept().fitted).toBe(true);
  });

  it('fitted, under reduced motion: the line\'s refit jumps', () => {
    open();
    reduced = true;
    line(62);
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    expectClose(camera(), fitBelowLine());
  });

  it('a line that wraps to more rows refits again while fitted', () => {
    open();
    line(26);
    runFrames();
    line(62);
    runFrames();
    expectClose(camera(), fitBelowLine());
  });

  it('the same band (the stack resized with no change to its bottom) moves nothing', () => {
    open();
    line(0);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  for (const [name, move] of [['a drag pan', dragPan], ['a wheel notch', () => notch()], ['a pinch', pinch],
    ['a keyboard pan (no source event)', keyboardPan]] as const) {
    it(`after ${name} by the person: a line appearing or going leaves the camera (#213 round 3)`, () => {
      open();
      move();
      const moved = camera();
      flow.setViewport.mockClear();
      line(62);
      runFrames();
      line(0);
      runFrames();
      expect(flow.setViewport).not.toHaveBeenCalled();
      expect(camera()).toEqual(moved);
    });
  }

  it('after the zoom buttons: a line leaves the camera', () => {
    open();
    press('Zoom in');
    runFrames();
    const zoomed = camera();
    flow.setViewport.mockClear();
    line(62);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    expect(camera()).toEqual(zoomed);
  });

  it('after the zoom buttons back onto the fit: still the person\'s camera, so a line leaves it', () => {
    open();
    press('Zoom in');
    runFrames();
    press('Zoom out');
    runFrames();
    const back = camera();
    flow.setViewport.mockClear();
    line(62);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    expect(camera()).toEqual(back);
  });

  it('a pan mid-spring stops the follow and clears the flag: the line going later moves nothing', () => {
    open();
    line(62);
    step(16);
    step(32);
    const mid = camera();
    expect(mid.y).not.toBeCloseTo(fitBelowLine().y, 3);
    act(() => {
      flow.camera.x += 40;
      flow.props!.onMove!(wheel(), camera());
    });
    const panned = camera();
    flow.setViewport.mockClear();
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    expect(camera()).toEqual(panned);
    line(0);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    expect(camera()).toEqual(panned);
  });

  it('after a pan, Fit sets the flag again: the next line refits', () => {
    open();
    dragPan();
    act(() => { fitButton().click(); });
    runFrames();
    line(62);
    runFrames();
    expectClose(camera(), fitBelowLine());
  });

  it('a refit the app makes (the column resizes) keeps the flag: the next line refits', () => {
    open();
    act(() => { boxes.board = { top: 98, height: 542 }; boxes.stack = { top: 110, height: 0 }; });
    resize(870, 542);
    runFrames();
    expectClose(camera(), fitBelowLine());
    line(62);
    runFrames();
    expect(bandEnd()).toBe(86);
    expectClose(camera(), fitBelowLine());
    expect(camera().y).toBeGreaterThanOrEqual(86 - 0.5);
  });

  it('an agent\'s change to the board keeps the flag: the next line refits to every card there is now', () => {
    const view = open();
    const added = [...images, { id: 'd', url: '/api/outputs/d.png', weight: 1, notes: '', privateNote: '', excluded: false,
      placements: [{ ...card('cd', 1560), placedBy: 'agent' as const }] }];
    view.rerender(ui(added));
    expect(flow.setViewport).not.toHaveBeenCalled();
    line(62);
    runFrames();
    expectClose(camera(), fitBelowLine(2520));
  });

  it('an Update\'s Show sets the flag: a line frames the shown card again, clear of it', () => {
    open();
    dragPan();
    act(() => { useBoardCanvasStore.getState().requestFrame('k1', ['ca']); });
    runFrames();
    flow.setViewport.mockClear();
    line(62);
    runFrames();
    expect(flow.setViewport).toHaveBeenCalled();
    const to = getViewportForBounds({ x: 0, y: 0, width: 480, height: 270 }, 870, boxes.board.height - bandEnd() - 53, 0.02, 1, 0.12);
    expectClose(camera(), { x: to.x, y: to.y + bandEnd(), zoom: to.zoom });
  });

  it('a line before the view has any cards to fit moves nothing', () => {
    flow.state.width = 870;
    flow.state.height = boxes.board.height;
    render(ui([]));
    flow.setViewport.mockClear();
    line(62);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });
});

// #213 review 1 NIT-2: what the camera check counts as a move.
describe('a move is any change of the camera (#213 review 1 NIT-2)', () => {
  it('a pinch that changes only the zoom stops a refit spring (F1)', () => {
    mounted();
    resize(430, 851);
    step(0);
    step(16);
    act(() => {
      flow.camera.zoom *= 1.01;
      flow.props!.onMove!(wheel(), camera());
    });
    flow.setViewport.mockClear();
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a 0.3 px pan stops a refit spring: no tolerance on what counts as a move (F3)', () => {
    mounted();
    resize(430, 851);
    step(0);
    step(16);
    act(() => {
      flow.camera.x += 0.3;
      flow.props!.onMove!(wheel(), camera());
    });
    flow.setViewport.mockClear();
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('React Flow makes its camera again under a pan not kept yet: the pan is put back and kept at once (G11)', () => {
    mounted();
    act(() => {
      flow.camera.x -= 90;
      flow.props!.onMove!(wheel(), camera());
    });
    const moved = camera();
    act(() => {
      const previous = { ...flow.state, panZoom: flow.panZoom };
      flow.panZoom = {};
      Object.assign(flow.camera, { x: 0, y: 0, zoom: 1 });
      for (const listener of flow.listeners) listener({ ...flow.state, panZoom: flow.panZoom }, previous);
    });
    expect(kept()).toEqual({ viewport: moved, fitted: false });
  });
});

// GM, #213 round 3b: fitted is the person's intent. A card added or moved
// while the board is fitted keeps it fitted: the camera doesn't move, and the
// next resize refits to the cards there are then.
describe('cards added or moved while fitted (GM, #213 round 3b)', () => {
  const rerender = (view: ReturnType<typeof mount>, list: MoodboardImage[]) =>
    view.rerender(<BoardCanvas boardKey="k1" images={list} onMove={() => {}} onDropFiles={() => {}} />);
  const added = [...images, { id: 'd', url: '/api/outputs/d.png', weight: 1, notes: '', privateNote: '', excluded: false, placements: [card('cd', 1560)] }];
  const moved = images.map((image) => (image.id === 'a' ? { ...image, placements: [card('ca', 1560)] } : image));

  it('Fit, then a card added: the camera stays, the board stays fitted, and a resize refits to all four cards', () => {
    const view = mounted();
    notch();
    act(() => { fitButton().click(); });
    runFrames();
    expect(kept().fitted).toBe(true);
    flow.setViewport.mockClear();
    rerender(view, added);
    expect(flow.setViewport).not.toHaveBeenCalled();
    expect(camera()).toEqual(fitViewport(870, 851));
    resize(430, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851, 2520));
    expect(kept()).toEqual({ viewport: fitViewport(430, 851, 2520), fitted: true });
  });

  it('fitted, then a card moved further out: the camera stays, and a resize refits to where the cards are now', () => {
    const view = mounted();
    flow.setViewport.mockClear();
    rerender(view, moved);
    expect(flow.setViewport).not.toHaveBeenCalled();
    resize(430, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851, 2520));
  });

  it('fitted, a card added, then List and back: it reopens fitted to all four cards', () => {
    const view = mounted();
    rerender(view, added);
    act(() => { flow.props!.onMoveEnd!(null, camera()); }); // a late move end keeps the camera with its flag
    expect(kept().fitted).toBe(true);
    view.unmount();
    render(<BoardCanvas boardKey="k1" images={added} onMove={() => {}} onDropFiles={() => {}} />);
    expect(camera()).toEqual(fitViewport(870, 851, 2520));
  });

  it('a card added, then a pan: not fitted, and a resize keeps the view', () => {
    const view = mounted();
    rerender(view, added);
    stuckPan();
    flow.setViewport.mockClear();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
    expect(kept().fitted).toBe(false);
  });

  it('a pan off the fit, then a card added: still not fitted', () => {
    const view = mounted();
    stuckPan();
    rerender(view, added);
    flow.setViewport.mockClear();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a pan back exactly onto the fit, then a card added: fitted, and a resize refits to all four', () => {
    const view = mounted();
    autopan({ ...fitViewport(870, 851), x: -400 });
    expect(kept().fitted).toBe(false);
    autopan(fitViewport(870, 851));
    expect(kept().fitted).toBe(true);
    rerender(view, added);
    resize(430, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851, 2520));
  });

  it('the zoom buttons after a card added: zoom in clears it', () => {
    const view = mounted();
    rerender(view, added);
    press('Zoom in');
    runFrames();
    expect(kept().fitted).toBe(false);
    flow.setViewport.mockClear();
    resize(430, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a Fit spring with a card added while it runs: it lands fitted, and a resize refits to all four', () => {
    const view = mounted();
    notch();
    act(() => { fitButton().click(); });
    step(0);
    step(16);
    rerender(view, added);
    runFrames();
    expect(kept().fitted).toBe(true);
    resize(430, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851, 2520));
  });
});

// Review 2 LOW-2 and NIT-2: the band measured in a browser, and the close keep's flag.
describe('the measured control-bar band (review 2 LOW-2)', () => {
  /** Lay out the board 851 tall and its bar `band` px from the bottom; `on` false is no layout (the view closing). */
  const layout = (band: number) => {
    const state = { on: true };
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const at = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 870, width: 870, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
      if (!state.on) return at(0, 0);
      if (this.classList.contains('moodboard-board__controls')) return at(flow.state.height - band, 38);
      if (this.classList.contains('moodboard-board')) return at(0, flow.state.height);
      return at(0, 0);
    });
    return state;
  };
  const fitAbove = (width: number, height: number, band: number) =>
    getViewportForBounds({ x: 0, y: 0, width: 2000, height: 1000 }, width, height - band, 0.02, 1, 0.12);
  afterEach(() => { vi.restoreAllMocks(); });

  it('a wrapped bar (a 91 px band): Fit frames the cards above it', () => {
    layout(91);
    mounted();
    notch();
    act(() => { fitButton().click(); });
    runFrames();
    expect(camera()).toEqual(fitAbove(870, 851, 91));
  });

  it('with no layout to measure, the last measured band is used, not the fallback', () => {
    const state = layout(91);
    mounted();
    expect(camera()).toEqual(fitAbove(870, 851, 91));
    state.on = false;
    notch();
    act(() => { fitButton().click(); });
    runFrames();
    expect(camera()).toEqual(fitAbove(870, 851, 91));
  });
});

describe('the close keep\'s flag (review 2 R9)', () => {
  it('a pan back onto the fit, closed before it is kept: kept fitted, so it reopens fitted to its column then', () => {
    const view = mounted();
    act(() => {
      flow.camera.x -= 90;
      flow.props!.onMove!(wheel(), camera());
    });
    act(() => {
      Object.assign(flow.camera, fitViewport(870, 851));
      flow.props!.onMove!(wheel(), camera());
    });
    view.unmount();
    expect(kept()).toEqual({ viewport: fitViewport(870, 851), fitted: true });
    flow.state.width = 430;
    mount();
    expect(camera()).toEqual(fitViewport(430, 851));
  });
});

describe('review 7 (saveaway-merge-logic-r6b): Fit with held spots after the #213 merge', () => {
  const held = [{ id: 'placeholder-1', x: 4000, y: 100, width: 300, height: 200, source: { kind: 'file' as const, name: 'a.png' } }];
  it('R7-F1: Fit with a held spot is a fit: a resize refits it, and it is kept fitted', () => {
    render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} placeholders={held} />);
    flow.setViewport.mockClear();
    notch();
    act(() => { fitButton().click(); });
    runFrames();
    const fitCam = camera();
    resize(430, 851);
    runFrames();
    expect(camera()).not.toEqual(fitCam);
    expect(kept().fitted).toBe(true);
  });
  it('R7-F2: a fitted board, a paste held, a resize: still fitted after the spot has gone', () => {
    const wide = [{ id: 'placeholder-1', x: 3000, y: 400, width: 300, height: 200, source: { kind: 'file' as const, name: 'a.png' } }];
    const view = render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} />);
    expect(kept().fitted).toBe(true);
    view.rerender(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} placeholders={wide} />);
    resize(600, 851);
    runFrames();
    view.rerender(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} />);
    resize(430, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851));
  });

  it('a placeholder outside the cards, then Fit: fitted to the cards and the spot; a narrower column refits to both; only a person\'s move unfits it', () => {
    render(<BoardCanvas boardKey="k1" images={images} onMove={() => {}} onDropFiles={() => {}} placeholders={held} />);
    notch();
    act(() => { fitButton().click(); });
    runFrames();
    // The mock board is 2000 wide for cards ending at x 1040; the spot at x 4000 widens it.
    expect(camera()).toEqual(fitViewport(870, 851, 4960));
    expect(kept().fitted).toBe(true);
    resize(430, 851);
    runFrames();
    expect(camera()).toEqual(fitViewport(430, 851, 4960));
    expect(kept().fitted).toBe(true);
    // A person's pan unfits it: a resize then keeps their view.
    act(() => {
      flow.props!.onMoveStart!(new MouseEvent('mousedown'), camera());
      flow.camera.x += 120;
      flow.props!.onMove!(new MouseEvent('mousemove', { clientX: 120 }), camera());
      flow.props!.onMoveEnd!(new MouseEvent('mouseup'), camera());
    });
    expect(kept().fitted).toBe(false);
    flow.setViewport.mockClear();
    resize(600, 851);
    runFrames();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });
});
