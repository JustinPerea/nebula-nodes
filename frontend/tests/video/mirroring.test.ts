import { describe, it, expect } from 'vitest';
import {
  componentTypeToCanvasDefId,
  pruneTrackItemsForDeletedNode,
} from '../../src/lib/video/mirroring';
import type { TrackItem, VideoGraphManifest } from '../../src/types/video';

describe('componentTypeToCanvasDefId', () => {
  it('maps each componentType to its canvas node id', () => {
    expect(componentTypeToCanvasDefId('TextNode')).toBe('text-input');
    expect(componentTypeToCanvasDefId('SVGInput')).toBe('text-input');
    expect(componentTypeToCanvasDefId('ImageAssetNode')).toBe('image-input');
    expect(componentTypeToCanvasDefId('VideoAssetNode')).toBe('video-input');
    expect(componentTypeToCanvasDefId('IsometricBlock')).toBe('text-input');
    expect(componentTypeToCanvasDefId('LottieNode')).toBe('image-input');
  });
});

const SAMPLE_ITEM: TrackItem = {
  id: 't1',
  sourceNodeId: 'canvas-n1',
  componentType: 'TextNode',
  time: { startFrame: 0, durationInFrames: 60 },
  spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
  keyframes: {},
  props: { text: 'hello' },
};

describe('pruneTrackItemsForDeletedNode', () => {
  it('removes TrackItems whose sourceNodeId matches the deleted node', () => {
    const manifest: VideoGraphManifest = {
      graph: { nodes: [], edges: [] },
      timeline: [SAMPLE_ITEM, { ...SAMPLE_ITEM, id: 't2', sourceNodeId: 'canvas-n2' }],
    };
    const result = pruneTrackItemsForDeletedNode(manifest, 'canvas-n1');
    expect(result.changed).toBe(true);
    expect(result.manifest.timeline).toHaveLength(1);
    expect(result.manifest.timeline[0].id).toBe('t2');
  });

  it('returns changed=false when no TrackItem references the deleted node', () => {
    const manifest: VideoGraphManifest = {
      graph: { nodes: [], edges: [] },
      timeline: [SAMPLE_ITEM],
    };
    const result = pruneTrackItemsForDeletedNode(manifest, 'unrelated');
    expect(result.changed).toBe(false);
    expect(result.manifest).toBe(manifest);
  });

  it('handles empty timeline gracefully', () => {
    const manifest: VideoGraphManifest = {
      graph: { nodes: [], edges: [] },
      timeline: [],
    };
    const result = pruneTrackItemsForDeletedNode(manifest, 'anything');
    expect(result.changed).toBe(false);
    expect(result.manifest.timeline).toHaveLength(0);
  });
});
