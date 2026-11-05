import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
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
  useBoardCanvasStore.setState({ selection: {}, viewports: {}, fitted: {}, placed: {}, frameRequest: null });
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

// GM r5 (review 2 MEDIUM-1): a press follows the 1 px click rule however long
// it's held. React Flow ends each spring frame's gesture on a 150 ms timer
// with no source event; that end used to clear the press, so a press held
// past it lost the rule.
describe('a press held during a Fit spring, with 1 px of jitter (GM r5)', () => {
  const click = (name: string) => act(() => { (screen.getByRole('button', { name }) as HTMLButtonElement).click(); });
  async function pressDuringFitSpring(key: string, holdMs: number) {
    await open(key);
    const fit = flowCamera();
    scrollPan();
    await act(async () => { await sleep(250); });
    expect(flowCamera()).not.toEqual(fit);
    click('Fit the board');
    await act(async () => { await sleep(40); }); // a couple of spring frames
    const mid = flowCamera();
    const pane = document.querySelector('.react-flow__pane')!;
    mouse(pane, 'mousedown', { button: 1, buttons: 4, clientX: 300, clientY: 200 });
    await act(async () => { await sleep(holdMs); });
    mouse(window, 'mousemove', { buttons: 4, clientX: 301, clientY: 200 });
    mouse(window, 'mouseup', { button: 1, clientX: 301, clientY: 200 });
    await act(async () => { await sleep(1500); });
    return { fit, mid, end: flowCamera(), kept: kept(key) };
  }
  for (const hold of [30, 200, 400]) {
    it(`held ${hold} ms: the spring carries on to the fit, and the board is kept fitted`, async () => {
      const r = await pressDuringFitSpring(`hold${hold}`, hold);
      expect(r.mid).not.toEqual(r.fit);
      expect(r.end.x).toBeCloseTo(r.fit.x, 3);
      expect(r.end.y).toBeCloseTo(r.fit.y, 3);
      expect(r.kept.fitted).toBe(true);
    });
  }
});

// Review 2's close probes on the real store (NIT-2: R3, R4).
describe('closing mid-gesture, more cases (review 2)', () => {
  const click = (name: string) => act(() => { (screen.getByRole('button', { name }) as HTMLButtonElement).click(); });
  it('mid pinch (ctrl wheel): the pinch is kept', async () => {
    const view = await open('pinch');
    const pane = document.querySelector('.react-flow__renderer')!;
    for (const dy of [-10, -10, -10]) {
      act(() => { pane.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, ctrlKey: true, clientX: 400, clientY: 300, bubbles: true, cancelable: true })); });
    }
    const camera = flowCamera();
    expect(camera.zoom).not.toBe(1);
    view.unmount();
    await act(async () => { await sleep(300); });
    expect(kept('pinch')).toEqual({ viewport: camera, fitted: false });
  });

  it('mid middle drag, released after the close: the drag so far is kept', async () => {
    const view = await open('mdrag');
    const pane = document.querySelector('.react-flow__pane')!;
    mouse(pane, 'mousedown', { button: 1, buttons: 4, clientX: 300, clientY: 200 });
    mouse(window, 'mousemove', { buttons: 4, clientX: 360, clientY: 230 });
    const camera = flowCamera();
    view.unmount();
    expect(kept('mdrag')).toEqual({ viewport: camera, fitted: false });
    mouse(window, 'mousemove', { buttons: 4, clientX: 400, clientY: 230 });
    mouse(window, 'mouseup', { button: 1, clientX: 400, clientY: 230 });
    await act(async () => { await sleep(300); });
    expect(kept('mdrag')).toEqual({ viewport: camera, fitted: false });
  });

  it('mid Fit spring: the fit is kept, fitted', async () => {
    const view = await open('fitspring');
    const fit = flowCamera();
    scrollPan();
    await act(async () => { await sleep(250); });
    click('Fit the board');
    await act(async () => { await sleep(50); });
    expect(flowCamera()).not.toEqual(fit);
    view.unmount();
    await act(async () => { await sleep(300); });
    expect(kept('fitspring')).toEqual({ viewport: fit, fitted: true });
  });

  it('a scroll pan, Fit, closed before the spring lands, reopened: it opens on the fit (R3)', async () => {
    const view = await open('re');
    const fit = flowCamera();
    scrollPan();
    click('Fit the board');
    view.unmount();
    await act(async () => { await sleep(300); });
    expect(kept('re')).toEqual({ viewport: fit, fitted: true });
    await open('re');
    expect(flowCamera()).toEqual(fit);
  });
});

// main.tsx renders under StrictMode: in development React mounts, unmounts
// and mounts again, so the close must not leave the view closed (R4).
describe('under StrictMode on the real store (review 2)', () => {
  async function openStrict(key: string) {
    const view = render(<StrictMode><BoardCanvas boardKey={key} images={images} onMove={() => {}} onDropFiles={() => {}} /></StrictMode>);
    await screen.findAllByLabelText(/^Reference #\d/);
    await act(async () => { await sleep(50); });
    return view;
  }
  it('opens fitted, keeps a pan closed mid-gesture, and reopens on it', async () => {
    const plain = await open('plain');
    const plainFit = flowCamera();
    plain.unmount();
    const view = await openStrict('strict');
    expect(flowCamera()).toEqual(plainFit);
    expect(kept('strict')).toEqual({ viewport: plainFit, fitted: true });
    const camera = scrollPan();
    await act(async () => { await sleep(300); });
    expect(kept('strict')).toEqual({ viewport: camera, fitted: false }); // kept after mount, not only at close
    const again = scrollPan();
    view.unmount();
    expect(kept('strict')).toEqual({ viewport: again, fitted: false });
    await act(async () => { await sleep(300); });
    await openStrict('strict');
    expect(flowCamera()).toEqual(again);
  });

  it('a board switch mid-pan keeps the first board\'s pan; the second opens fitted', async () => {
    const view = render(<StrictMode><BoardCanvas key="b1" boardKey="b1" images={images} onMove={() => {}} onDropFiles={() => {}} /></StrictMode>);
    await screen.findAllByLabelText(/^Reference #\d/);
    await act(async () => { await sleep(50); });
    const camera = scrollPan();
    view.rerender(<StrictMode><BoardCanvas key="b2" boardKey="b2" images={images} onMove={() => {}} onDropFiles={() => {}} /></StrictMode>);
    await act(async () => { await sleep(300); });
    expect(kept('b1')).toEqual({ viewport: camera, fitted: false });
    expect(kept('b2').fitted).toBe(true);
    expect(flowCamera()).toEqual(kept('b2').viewport);
  });
});
