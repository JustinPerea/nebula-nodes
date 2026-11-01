import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { MoodboardImage } from '../../types';

// #213 review 1 MEDIUM-1: React Flow's REAL store and d3 pan-zoom, not the
// stand-in of BoardCanvas.fitFollow.test.tsx. When the view closes, React
// Flow's StoreUpdater (a child of the board) resets its store to the camera
// (0, 0, 1) in a layout cleanup, before any passive cleanup runs, and its
// pan-on-scroll ends a gesture on a 150 ms timer that outlives the view. The
// stand-in does neither, so only this file can see what closing keeps.

type Transform = [number, number, number];
const grabbed: { store: { getState: () => { transform: Transform } } | null } = { store: null };
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  function Grab() {
    grabbed.store = actual.useStoreApi() as never;
    return null;
  }
  return {
    ...actual,
    ReactFlowProvider: ({ children }: { children: ReactNode }) => (
      <actual.ReactFlowProvider><Grab />{children}</actual.ReactFlowProvider>
    ),
  };
});

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // React Flow measures the board from its offset size.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 1200; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 800; } });
});
beforeEach(() => {
  useBoardCanvasStore.setState({ selection: {}, viewports: {}, fitted: {}, frameRequest: null });
});
afterEach(() => cleanup());

import { BoardCanvas } from './BoardCanvas';
import { useBoardCanvasStore } from '../../store/boardCanvasStore';

const images: MoodboardImage[] = ['i1', 'i2'].map((id, index) => ({
  id, url: `/api/outputs/${id}.png`, weight: 1, notes: '', privateNote: '', excluded: false,
  placements: [{ id: `c-${id}`, frameId: null, x: index * 520, y: 0, w: 480, h: 270, weight: 1, placedBy: 'person', placedAt: '' }],
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const flowCamera = () => {
  const [x, y, zoom] = grabbed.store!.getState().transform;
  return { x, y, zoom };
};
const kept = (key: string) => ({ viewport: useBoardCanvasStore.getState().viewports[key], fitted: useBoardCanvasStore.getState().fitted[key] });

async function open(key: string) {
  const view = render(<BoardCanvas boardKey={key} images={images} onMove={() => {}} onDropFiles={() => {}} />);
  await screen.findAllByLabelText(/^Reference #\d/);
  await act(async () => { await sleep(50); });
  return view;
}

/** Three wheel events of a scroll pan (React Flow's pan-on-scroll); its move end comes 150 ms after the last. */
function scrollPan() {
  const pane = document.querySelector('.react-flow__renderer')!;
  for (const dy of [120, 120, 120]) {
    act(() => { pane.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaX: 0, bubbles: true, cancelable: true })); });
  }
  return flowCamera();
}

describe('closing the Board view keeps the camera the person left (#213 review 1 MEDIUM-1)', () => {
  it('control: left open, the scroll pan\'s move end keeps its camera', async () => {
    await open('ctl');
    const camera = scrollPan();
    await act(async () => { await sleep(400); });
    expect(kept('ctl')).toEqual({ viewport: camera, fitted: false });
  });

  it('closed mid scroll pan (List, another board): the pan is kept, not React Flow\'s reset camera, and its late move end changes nothing', async () => {
    const view = await open('close');
    const camera = scrollPan();
    expect(camera).not.toEqual({ x: 0, y: 0, zoom: 1 });
    view.unmount();
    expect(kept('close')).toEqual({ viewport: camera, fitted: false });
    await act(async () => { await sleep(400); }); // past React Flow's 150 ms move end
    expect(kept('close')).toEqual({ viewport: camera, fitted: false });
  });

  it('closed at rest on the fit: the store keeps the fit, fitted, and closing writes nothing', async () => {
    const view = await open('rest');
    const fit = flowCamera();
    expect(kept('rest')).toEqual({ viewport: fit, fitted: true });
    let writes = 0;
    const stop = useBoardCanvasStore.subscribe((state, previous) => { if (state.viewports !== previous.viewports) writes += 1; });
    view.unmount();
    expect(writes).toBe(0);
    stop();
    expect(kept('rest')).toEqual({ viewport: fit, fitted: true });
    await act(async () => { await sleep(200); });
    expect(kept('rest')).toEqual({ viewport: fit, fitted: true });
  });

  it('reopened after a close mid pan: it opens where the person left it', async () => {
    const view = await open('again');
    const camera = scrollPan();
    view.unmount();
    await act(async () => { await sleep(200); });
    await open('again');
    expect(flowCamera()).toEqual(camera);
  });
});

/**
 * A mouse event as d3 gets it: d3 listens for the move and the release on
 * the press's window (`event.view`). jsdom won't take vitest's window as a
 * constructor's `view`, so it is set on the event.
 */
const mouse = (target: Element | Window, type: string, init: MouseEventInit) => act(() => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'view', { value: window });
  target.dispatchEvent(event);
});

describe('a middle press that jitters 1 px on React Flow\'s real d3 (#213 review 1 LOW-1)', () => {
  it('moves nothing and leaves the board fitted', async () => {
    await open('jitter');
    const fit = flowCamera();
    const pane = document.querySelector('.react-flow__pane')!;
    mouse(pane, 'mousedown', { button: 1, buttons: 4, clientX: 300, clientY: 200 });
    mouse(window, 'mousemove', { buttons: 4, clientX: 301, clientY: 200 });
    expect(flowCamera()).toEqual(fit);
    mouse(window, 'mousemove', { buttons: 4, clientX: 300, clientY: 199 });
    expect(flowCamera()).toEqual(fit);
    mouse(window, 'mouseup', { button: 1, clientX: 300, clientY: 199 });
    await act(async () => { await sleep(200); }); // React Flow's move end (150 ms with pan-on-scroll)
    expect(kept('jitter')).toEqual({ viewport: fit, fitted: true });
  });

  it('a drag past it pans the camera, and the pan is kept', async () => {
    await open('drag');
    const fit = flowCamera();
    const pane = document.querySelector('.react-flow__pane')!;
    mouse(pane, 'mousedown', { button: 1, buttons: 4, clientX: 300, clientY: 200 });
    mouse(window, 'mousemove', { buttons: 4, clientX: 340, clientY: 200 });
    const panned = flowCamera();
    expect(panned.x).toBeCloseTo(fit.x + 40, 6);
    mouse(window, 'mouseup', { button: 1, clientX: 340, clientY: 200 });
    await act(async () => { await sleep(200); }); // React Flow's move end (150 ms with pan-on-scroll)
    expect(kept('drag')).toEqual({ viewport: panned, fitted: false });
  });
});
