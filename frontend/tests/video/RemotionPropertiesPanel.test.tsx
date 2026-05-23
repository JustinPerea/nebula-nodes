import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { RemotionPropertiesPanel } from '../../src/components/video-editor/RemotionPropertiesPanel';
import { useUIStore } from '../../src/store/uiStore';
import { useGraphStore } from '../../src/store/graphStore';
import type { TrackItem } from '../../src/types/video';

const INITIAL_UI_STATE = { ...useUIStore.getState() };
const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };

function makeTrackItem(overrides: Partial<TrackItem> = {}): TrackItem {
  return {
    id: 't1',
    sourceNodeId: 'src-1',
    componentType: 'TextNode',
    time: { startFrame: 0, durationInFrames: 60 },
    spatial: { x: 100, y: 50, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    keyframes: {},
    props: { text: 'hello' },
    ...overrides,
  };
}

function seedAndSelect(trackItem: TrackItem) {
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
  useUIStore.setState({ selectedTrackItemId: trackItem.id });
}

describe('RemotionPropertiesPanel — Transform section', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_UI_STATE, true);
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('renders the Transform section with Position X/Y/Z inputs reflecting current spatial', () => {
    seedAndSelect(makeTrackItem());
    const { container } = render(<RemotionPropertiesPanel remotionNodeId="r1" />);

    // Find the Transform section by h4 text
    const headings = Array.from(container.querySelectorAll('h4'));
    const transformHeading = headings.find((h) => h.textContent === 'Transform');
    expect(transformHeading).toBeDefined();

    const section = transformHeading?.closest('section');
    expect(section).not.toBeNull();

    const xInput = section?.querySelector('input[data-spatial-axis="x"]') as HTMLInputElement;
    const yInput = section?.querySelector('input[data-spatial-axis="y"]') as HTMLInputElement;
    const zInput = section?.querySelector('input[data-spatial-axis="z"]') as HTMLInputElement;
    expect(xInput.value).toBe('100');
    expect(yInput.value).toBe('50');
    expect(zInput.value).toBe('0');
  });

  it('typing in X dispatches updateTrackItemSpatial with new x and preserved y/z', () => {
    seedAndSelect(makeTrackItem());
    const { container } = render(<RemotionPropertiesPanel remotionNodeId="r1" />);

    const xInput = container.querySelector('input[data-spatial-axis="x"]') as HTMLInputElement;
    fireEvent.change(xInput, { target: { value: '250' } });

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(250);
    expect(manifest.timeline[0].spatial.y).toBe(50); // preserved
    expect(manifest.timeline[0].spatial.z).toBe(0);  // preserved
  });

  it('Transform section appears between Time and componentType-specific sections', () => {
    seedAndSelect(makeTrackItem({ componentType: 'TextNode' }));
    const { container } = render(<RemotionPropertiesPanel remotionNodeId="r1" />);

    const headings = Array.from(container.querySelectorAll('h4')).map((h) => h.textContent);
    const timeIdx = headings.indexOf('Time');
    const transformIdx = headings.indexOf('Transform');
    const textIdx = headings.indexOf('Text');
    expect(timeIdx).toBeGreaterThanOrEqual(0);
    expect(transformIdx).toBeGreaterThan(timeIdx);
    expect(textIdx).toBeGreaterThan(transformIdx);
  });

  it('renders the Transform section for every componentType (including IsoBlock)', () => {
    for (const componentType of ['TextNode', 'SVGInput', 'ImageAssetNode', 'VideoAssetNode', 'IsometricBlock', 'LottieNode'] as const) {
      useGraphStore.setState(INITIAL_GRAPH_STATE, true);
      useUIStore.setState(INITIAL_UI_STATE, true);
      seedAndSelect(makeTrackItem({ id: `t-${componentType}`, componentType }));
      const { container, unmount } = render(<RemotionPropertiesPanel remotionNodeId="r1" />);
      const headings = Array.from(container.querySelectorAll('h4')).map((h) => h.textContent);
      expect(headings).toContain('Transform');
      unmount();
    }
  });

  it('renders Scale X/Y/Z inputs below Position fields', () => {
    seedAndSelect(makeTrackItem({ spatial: { x: 100, y: 50, z: 0, scale: [2, 3, 4], rotation: [0, 0, 0] } }));
    const { getByLabelText } = render(<RemotionPropertiesPanel remotionNodeId="r1" />);

    expect((getByLabelText('Scale X') as HTMLInputElement).value).toBe('2');
    expect((getByLabelText('Scale Y') as HTMLInputElement).value).toBe('3');
    expect((getByLabelText('Scale Z') as HTMLInputElement).value).toBe('4');
  });

  it('typing in Scale X updates spatial.scale while preserving position and other scale axes', () => {
    seedAndSelect(makeTrackItem({ spatial: { x: 100, y: 50, z: 0, scale: [2, 3, 4], rotation: [0, 0, 0] } }));
    const { getByLabelText } = render(<RemotionPropertiesPanel remotionNodeId="r1" />);

    fireEvent.change(getByLabelText('Scale X'), { target: { value: '5' } });

    const remotion = useGraphStore.getState().nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(100);
    expect(manifest.timeline[0].spatial.y).toBe(50);
    expect(manifest.timeline[0].spatial.scale).toEqual([5, 3, 4]);
  });
});
