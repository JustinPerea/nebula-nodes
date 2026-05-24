import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { SelectionBox } from '../../src/components/video-editor/SelectionBox';
import { useUIStore } from '../../src/store/uiStore';
import { useGraphStore } from '../../src/store/graphStore';
import type { TrackItem } from '../../src/types/video';
import type { ResizeHandle } from '../../src/lib/video/resizeMath';

const INITIAL_UI_STATE = { ...useUIStore.getState() };
const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };

function makeTrackItem(overrides: Partial<TrackItem> = {}): TrackItem {
  return {
    id: 'track-xyz',
    sourceNodeId: 'src-1',
    componentType: 'TextNode',
    time: { startFrame: 0, durationInFrames: 60 },
    spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    keyframes: {},
    props: { text: 'hi' },
    ...overrides,
  };
}

function seedRemotionWithItem(trackItem: TrackItem) {
  seedRemotionWithItems([trackItem]);
}

function seedRemotionWithItems(trackItems: TrackItem[]) {
  const remotionNode = {
    id: 'r1',
    type: 'remotionNode',
    position: { x: 0, y: 0 },
    data: {
      definitionId: 'remotion-node',
      label: 'R',
      params: { manifest: { graph: { nodes: [], edges: [] }, timeline: trackItems } },
      state: 'idle' as const,
      outputs: {},
    },
  };
  useGraphStore.setState({ nodes: [remotionNode as never] });
}

function makePlayerFrameRef(width = 1280, height = 720): { current: HTMLElement } {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}),
  });
  return { current: el };
}

function setupSelectedLayer(spatial: TrackItem['spatial'] = { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] }) {
  const layerEl = document.createElement('div');
  layerEl.setAttribute('data-track-item-id', 'track-xyz');
  layerEl.setAttribute('data-track-item-content-id', 'track-xyz');
  vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
    left: 100, top: 100, width: 200, height: 100, right: 300, bottom: 200, x: 100, y: 100, toJSON: () => ({}),
  });
  document.body.appendChild(layerEl);
  seedRemotionWithItem(makeTrackItem({ spatial }));
  return layerEl;
}

function setOffsetSize(el: HTMLElement, width: number, height: number) {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
}

function readSelectedScale(): TrackItem['spatial']['scale'] {
  const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
  const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
  return manifest.timeline[0].spatial.scale;
}

function readSelectedRotation(): TrackItem['spatial']['rotation'] {
  const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
  const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
  return manifest.timeline[0].spatial.rotation;
}

function readSelectedItem(): TrackItem {
  const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
  const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
  return manifest.timeline[0];
}

function dragHandle(container: HTMLElement, handle: ResizeHandle, options: { dx: number; dy: number; shiftKey?: boolean }) {
  const el = container.querySelector(`[data-resize-handle="${handle}"]`) as HTMLElement;
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(el, { pointerId: 2, clientX: 300, clientY: 200 });
  fireEvent.pointerMove(el, {
    pointerId: 2,
    clientX: 300 + options.dx,
    clientY: 200 + options.dy,
    shiftKey: options.shiftKey ?? false,
  });
  fireEvent.pointerUp(el, {
    pointerId: 2,
    clientX: 300 + options.dx,
    clientY: 200 + options.dy,
  });
}

function dragRotationHandle(container: HTMLElement, options: { toX: number; toY: number }) {
  const el = container.querySelector('[data-rotation-handle="z"]') as HTMLElement;
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(el, { pointerId: 3, clientX: 200, clientY: 70 });
  fireEvent.pointerMove(el, { pointerId: 3, clientX: options.toX, clientY: options.toY });
  fireEvent.pointerUp(el, { pointerId: 3, clientX: options.toX, clientY: options.toY });
}

describe('SelectionBox — scaffolding', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    document.querySelectorAll('[data-track-item-id], [data-track-item-content-id]').forEach((el) => el.remove());
  });

  it('renders nothing when target element does not exist in DOM', () => {
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="missing" playerFrameRef={playerFrameRef} />,
    );
    expect(container.querySelector('.remotion-selection-box')).toBeNull();
  });

  it('renders an outline div positioned via getBoundingClientRect', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    layerEl.setAttribute('data-track-item-content-id', 'track-xyz');
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 200, width: 300, height: 150, right: 400, bottom: 350, x: 100, y: 200, toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);

    const playerFrameRef = makePlayerFrameRef();
    seedRemotionWithItem(makeTrackItem());
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );
    const box = container.querySelector('.remotion-selection-box') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.style.left).toBe('100px');
    expect(box.style.top).toBe('200px');
    expect(box.style.width).toBe('300px');
    expect(box.style.height).toBe('150px');

    document.body.removeChild(layerEl);
  });

  it('rotates the outline around the selected layer center instead of drawing the transformed AABB', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    layerEl.setAttribute('data-track-item-content-id', 'track-xyz');
    setOffsetSize(layerEl, 200, 100);
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 93.93398282201788,
      top: 43.93398282201788,
      width: 212.13203435596427,
      height: 212.13203435596424,
      right: 306.06601717798213,
      bottom: 256.06601717798213,
      x: 93.93398282201788,
      y: 43.93398282201788,
      toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);

    const playerFrameRef = makePlayerFrameRef();
    seedRemotionWithItem(makeTrackItem({ spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 45] } }));
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );
    const box = container.querySelector('.remotion-selection-box') as HTMLElement;
    expect(Number.parseFloat(box.style.left)).toBeCloseTo(100);
    expect(Number.parseFloat(box.style.top)).toBeCloseTo(100);
    expect(Number.parseFloat(box.style.width)).toBeCloseTo(200);
    expect(Number.parseFloat(box.style.height)).toBeCloseTo(100);
    expect(box.style.transform).toBe('rotateZ(45deg)');

    document.body.removeChild(layerEl);
  });

  it('uses interpolated scale and rotation for the outline at the current frame', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    layerEl.setAttribute('data-track-item-content-id', 'track-xyz');
    setOffsetSize(layerEl, 100, 40);
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 90, top: 0, width: 120, height: 200, right: 210, bottom: 200, x: 90, y: 0, toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);

    const playerFrameRef = makePlayerFrameRef();
    seedRemotionWithItem(makeTrackItem({
      spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
      keyframes: {
        scale: [{ frame: 30, value: [2, 3, 1], easing: 'linear' }],
        rotation: [{ frame: 30, value: [0, 0, 90], easing: 'linear' }],
      },
    }));
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} currentFrame={30} />,
    );
    const box = container.querySelector('.remotion-selection-box') as HTMLElement;
    expect(Number.parseFloat(box.style.left)).toBeCloseTo(50);
    expect(Number.parseFloat(box.style.top)).toBeCloseTo(40);
    expect(Number.parseFloat(box.style.width)).toBeCloseTo(200);
    expect(Number.parseFloat(box.style.height)).toBeCloseTo(120);
    expect(box.style.transform).toBe('rotateZ(90deg)');

    document.body.removeChild(layerEl);
  });
});

describe('SelectionBox — body drag', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    document.querySelectorAll('[data-track-item-id], [data-track-item-content-id]').forEach((el) => el.remove());
  });

  it('pointerdown → pointermove dispatches updateTrackItemSpatial with scaled deltas', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    layerEl.setAttribute('data-track-item-content-id', 'track-xyz');
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 100, width: 200, height: 100, right: 300, bottom: 200, x: 100, y: 100, toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);
    seedRemotionWithItem(makeTrackItem({ spatial: { x: 50, y: 25, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] } }));

    const playerFrameRef = makePlayerFrameRef(640, 360); // half composition size → 2x scaling
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );
    const body = container.querySelector('.remotion-selection-box__body') as HTMLElement;
    // Mock setPointerCapture so JSDOM doesn't throw on it
    body.setPointerCapture = vi.fn();
    body.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(body, { pointerId: 1, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 250, clientY: 175 }); // +50, +25 screen
    // 50 screen px on a 640-wide player → 100 composition px (2x scale)
    // 25 screen px on a 360-tall player → 50 composition px
    // Final spatial: x = 50 + 100 = 150, y = 25 + 50 = 75

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(150);
    expect(manifest.timeline[0].spatial.y).toBe(75);

    fireEvent.pointerUp(body, { pointerId: 1, clientX: 250, clientY: 175 });
    document.body.removeChild(layerEl);
  });

  it('dragging one selected box moves every selected TrackItem by the same delta', () => {
    const layerA = document.createElement('div');
    layerA.setAttribute('data-track-item-id', 'track-a');
    layerA.setAttribute('data-track-item-content-id', 'track-a');
    vi.spyOn(layerA, 'getBoundingClientRect').mockReturnValue({
      left: 100, top: 100, width: 200, height: 100, right: 300, bottom: 200, x: 100, y: 100, toJSON: () => ({}),
    });
    document.body.appendChild(layerA);
    seedRemotionWithItems([
      makeTrackItem({
        id: 'track-a',
        spatial: { x: 10, y: 20, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
      }),
      makeTrackItem({
        id: 'track-b',
        spatial: { x: -5, y: 15, z: 2, scale: [1, 1, 1], rotation: [0, 0, 0] },
      }),
    ]);
    useUIStore.setState({ selectedTrackItemId: 'track-a', selectedTrackItemIds: ['track-a', 'track-b'] });

    const playerFrameRef = makePlayerFrameRef(640, 360);
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-a" playerFrameRef={playerFrameRef} />,
    );
    const body = container.querySelector('.remotion-selection-box__body') as HTMLElement;
    body.setPointerCapture = vi.fn();
    body.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(body, { pointerId: 1, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 225, clientY: 170 });

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline.find((item) => item.id === 'track-a')?.spatial).toMatchObject({ x: 60, y: 60 });
    expect(manifest.timeline.find((item) => item.id === 'track-b')?.spatial).toMatchObject({ x: 45, y: 55, z: 2 });

    document.body.removeChild(layerA);
  });

  it('pointerdown without move does NOT mutate spatial', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    layerEl.setAttribute('data-track-item-content-id', 'track-xyz');
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);
    seedRemotionWithItem(makeTrackItem({ spatial: { x: 10, y: 20, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] } }));

    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );
    const body = container.querySelector('.remotion-selection-box__body') as HTMLElement;
    body.setPointerCapture = vi.fn();
    body.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(body, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 50, clientY: 50 });

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(10);
    expect(manifest.timeline[0].spatial.y).toBe(20);

    document.body.removeChild(layerEl);
  });

  it('ignores pointer jitter inside the 4px dead-zone', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    layerEl.setAttribute('data-track-item-content-id', 'track-xyz');
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);
    seedRemotionWithItem(makeTrackItem({ spatial: { x: 10, y: 20, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] } }));

    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );
    const body = container.querySelector('.remotion-selection-box__body') as HTMLElement;
    body.setPointerCapture = vi.fn();
    body.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(body, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 53, clientY: 50 });
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 53, clientY: 50 });

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(10);
    expect(manifest.timeline[0].spatial.y).toBe(20);

    document.body.removeChild(layerEl);
  });

  it('pointercancel clears the active body drag session', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    layerEl.setAttribute('data-track-item-content-id', 'track-xyz');
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);
    seedRemotionWithItem(makeTrackItem({ spatial: { x: 10, y: 20, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] } }));

    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );
    const body = container.querySelector('.remotion-selection-box__body') as HTMLElement;
    body.setPointerCapture = vi.fn();
    body.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(body, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerCancel(body, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 80, clientY: 50 });

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(10);
    expect(manifest.timeline[0].spatial.y).toBe(20);
    expect(body.releasePointerCapture).toHaveBeenCalledWith(1);

    document.body.removeChild(layerEl);
  });
});

describe('SelectionBox — content-id fallback', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    document.querySelectorAll('[data-track-item-id], [data-track-item-content-id]').forEach((el) => el.remove());
  });

  it('falls back to data-track-item-id when no content-id element exists', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
    // Note: NO data-track-item-content-id set
    vi.spyOn(layerEl, 'getBoundingClientRect').mockReturnValue({
      left: 50, top: 60, width: 100, height: 50, right: 150, bottom: 110, x: 50, y: 60, toJSON: () => ({}),
    });
    document.body.appendChild(layerEl);

    const playerFrameRef = makePlayerFrameRef();
    seedRemotionWithItem(makeTrackItem());
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );
    const box = container.querySelector('.remotion-selection-box') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.style.left).toBe('50px');

    document.body.removeChild(layerEl);
  });
});

describe('SelectionBox — resize handles', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    document.querySelectorAll('[data-track-item-id], [data-track-item-content-id]').forEach((el) => el.remove());
  });

  it('renders eight resize handles with stable data attributes', () => {
    const layerEl = setupSelectedLayer();
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );

    const handles = Array.from(container.querySelectorAll('[data-resize-handle]')).map(
      (el) => (el as HTMLElement).dataset.resizeHandle,
    );
    expect(handles).toEqual([
      'corner-tl',
      'corner-tr',
      'corner-bl',
      'corner-br',
      'edge-top',
      'edge-right',
      'edge-bottom',
      'edge-left',
    ]);

    document.body.removeChild(layerEl);
  });

  it('corner drag scales proportionally by default', () => {
    const layerEl = setupSelectedLayer({ x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] });
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );

    dragHandle(container, 'corner-br', { dx: 40, dy: 10 });

    expect(readSelectedScale()).toEqual([1.2, 1.2, 1]);
    document.body.removeChild(layerEl);
  });

  it('Shift corner drag scales X and Y independently', () => {
    const layerEl = setupSelectedLayer({ x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] });
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );

    dragHandle(container, 'corner-br', { dx: 40, dy: 10, shiftKey: true });

    expect(readSelectedScale()).toEqual([1.2, 1.1, 1]);
    document.body.removeChild(layerEl);
  });

  it('right edge drag updates only scale.x', () => {
    const layerEl = setupSelectedLayer({ x: 0, y: 0, z: 0, scale: [2, 3, 4], rotation: [0, 0, 0] });
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );

    dragHandle(container, 'edge-right', { dx: 40, dy: 80 });

    expect(readSelectedScale()).toEqual([2.4, 3, 4]);
    document.body.removeChild(layerEl);
  });

  it('bottom edge drag updates only scale.y', () => {
    const layerEl = setupSelectedLayer({ x: 0, y: 0, z: 0, scale: [2, 3, 4], rotation: [0, 0, 0] });
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );

    dragHandle(container, 'edge-bottom', { dx: 80, dy: 20 });

    const scale = readSelectedScale();
    expect(scale[0]).toBe(2);
    expect(scale[1]).toBeCloseTo(3.6);
    expect(scale[2]).toBe(4);
    document.body.removeChild(layerEl);
  });
});

describe('SelectionBox — rotation handle', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    document.querySelectorAll('[data-track-item-id], [data-track-item-content-id]').forEach((el) => el.remove());
  });

  it('renders one rotation handle with a stable data attribute', () => {
    const layerEl = setupSelectedLayer();
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );

    const handle = container.querySelector('[data-rotation-handle="z"]');
    expect(handle).not.toBeNull();
    expect(container.querySelectorAll('[data-rotation-handle]')).toHaveLength(1);
    document.body.removeChild(layerEl);
  });

  it('rotation handle drag updates rotation.z', () => {
    const layerEl = setupSelectedLayer({ x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] });
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );

    dragRotationHandle(container, { toX: 300, toY: 150 });

    expect(readSelectedRotation()).toEqual([0, 0, 90]);
    document.body.removeChild(layerEl);
  });

  it('rotation handle drag preserves rotation.x and rotation.y', () => {
    const layerEl = setupSelectedLayer({ x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [15, 30, 45] });
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} />,
    );

    dragRotationHandle(container, { toX: 200, toY: 200 });

    expect(readSelectedRotation()).toEqual([15, 30, 180]);
    document.body.removeChild(layerEl);
  });
});

describe('SelectionBox — record-mode drag routing', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    document.querySelectorAll('[data-track-item-id], [data-track-item-content-id]').forEach((el) => el.remove());
  });

  it('body drag with recording on inserts a position keyframe and leaves static position unchanged', () => {
    const layerEl = setupSelectedLayer({ x: 10, y: 20, z: 5, scale: [1, 1, 1], rotation: [0, 0, 0] });
    useUIStore.setState({ isKeyframeRecording: true });
    const playerFrameRef = makePlayerFrameRef(640, 360);
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} currentFrame={30} />,
    );
    const body = container.querySelector('.remotion-selection-box__body') as HTMLElement;
    body.setPointerCapture = vi.fn();
    body.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(body, { pointerId: 1, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 250, clientY: 175 });
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 250, clientY: 175 });

    const item = readSelectedItem();
    expect(item.spatial.x).toBe(10);
    expect(item.spatial.y).toBe(20);
    expect(item.keyframes.position).toEqual([
      { frame: 30, value: [110, 70, 5], easing: 'linear' },
    ]);
    document.body.removeChild(layerEl);
  });

  it('resize drag with recording on inserts a scale keyframe and leaves static scale unchanged', () => {
    const layerEl = setupSelectedLayer({ x: 0, y: 0, z: 0, scale: [2, 3, 4], rotation: [0, 0, 0] });
    useUIStore.setState({ isKeyframeRecording: true });
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} currentFrame={31} />,
    );

    dragHandle(container, 'edge-right', { dx: 40, dy: 80 });

    const item = readSelectedItem();
    expect(item.spatial.scale).toEqual([2, 3, 4]);
    expect(item.keyframes.scale).toEqual([
      { frame: 31, value: [2.4, 3, 4], easing: 'linear' },
    ]);
    document.body.removeChild(layerEl);
  });

  it('rotation drag with recording on inserts a rotation keyframe and leaves static rotation unchanged', () => {
    const layerEl = setupSelectedLayer({ x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [15, 30, 45] });
    useUIStore.setState({ isKeyframeRecording: true });
    const playerFrameRef = makePlayerFrameRef();
    const { container } = render(
      <SelectionBox remotionNodeId="r1" trackItemId="track-xyz" playerFrameRef={playerFrameRef} currentFrame={32} />,
    );

    dragRotationHandle(container, { toX: 300, toY: 150 });

    const item = readSelectedItem();
    expect(item.spatial.rotation).toEqual([15, 30, 45]);
    expect(item.keyframes.rotation).toEqual([
      { frame: 32, value: [15, 30, 90], easing: 'linear' },
    ]);
    document.body.removeChild(layerEl);
  });
});
