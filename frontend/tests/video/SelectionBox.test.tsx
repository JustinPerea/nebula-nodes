import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { SelectionBox } from '../../src/components/video-editor/SelectionBox';
import { useUIStore } from '../../src/store/uiStore';
import { useGraphStore } from '../../src/store/graphStore';
import type { TrackItem } from '../../src/types/video';

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
  const remotionNode = {
    id: 'r1',
    type: 'remotionNode',
    position: { x: 0, y: 0 },
    data: {
      definitionId: 'remotion-node',
      label: 'R',
      params: { manifest: { graph: { nodes: [], edges: [] }, timeline: [trackItem] } },
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

describe('SelectionBox — scaffolding', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    document.querySelectorAll('[data-track-item-id]').forEach((el) => el.remove());
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
});

describe('SelectionBox — body drag', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
    document.querySelectorAll('[data-track-item-id]').forEach((el) => el.remove());
  });

  it('pointerdown → pointermove dispatches updateTrackItemSpatial with scaled deltas', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
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

  it('pointerdown without move does NOT mutate spatial', () => {
    const layerEl = document.createElement('div');
    layerEl.setAttribute('data-track-item-id', 'track-xyz');
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
});
