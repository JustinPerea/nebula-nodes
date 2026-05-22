import { describe, it, expect, beforeEach } from 'vitest';
import { useGraphStore } from '../../src/store/graphStore';
import type { TrackItem } from '../../src/types/video';

const INITIAL_GRAPH_STATE = { ...useGraphStore.getState() };

function makeTrackItem(overrides: Partial<TrackItem> = {}): TrackItem {
  return {
    id: 't1',
    sourceNodeId: 'src-1',
    componentType: 'TextNode',
    time: { startFrame: 0, durationInFrames: 60 },
    spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    keyframes: {},
    props: { text: 'hello' },
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
      params: {
        manifest: { graph: { nodes: [], edges: [] }, timeline: [trackItem] },
      },
      state: 'idle' as const,
      outputs: {},
    },
  };
  const sourceNode = {
    id: trackItem.sourceNodeId,
    type: 'model-node',
    position: { x: -300, y: 0 },
    data: { definitionId: 'text-input', label: 'text-input', params: {}, state: 'idle' as const, outputs: {} },
  };
  useGraphStore.setState({ nodes: [remotionNode as never, sourceNode as never] });
}

describe('graphStore — deleteTrackItem', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('removes the TrackItem AND its source canvas node atomically', () => {
    seedRemotionWithItem(makeTrackItem());
    useGraphStore.getState().deleteTrackItem('r1', 't1');

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: unknown[] } }).manifest;
    expect(manifest.timeline).toHaveLength(0);
    expect(state.nodes.find((n) => n.id === 'src-1')).toBeUndefined();
  });

  it('no-ops if the TrackItem does not exist', () => {
    seedRemotionWithItem(makeTrackItem());
    useGraphStore.getState().deleteTrackItem('r1', 'does-not-exist');

    const state = useGraphStore.getState();
    expect(state.nodes).toHaveLength(2);
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: unknown[] } }).manifest;
    expect(manifest.timeline).toHaveLength(1);
  });

  it('no-ops if the RemotionNode does not exist', () => {
    useGraphStore.getState().deleteTrackItem('does-not-exist', 't1');
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });
});

describe('graphStore — duplicateTrackItemAtPlayhead', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('clones the TrackItem at the given frame and spawns a new source node', () => {
    seedRemotionWithItem(makeTrackItem({ time: { startFrame: 0, durationInFrames: 60 } }));
    useGraphStore.getState().duplicateTrackItemAtPlayhead('r1', 't1', 45);

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline).toHaveLength(2);

    const clone = manifest.timeline.find((t) => t.id !== 't1')!;
    expect(clone.time.startFrame).toBe(45);
    expect(clone.time.durationInFrames).toBe(60);
    expect(clone.componentType).toBe('TextNode');
    expect(clone.props.text).toBe('hello');
    expect(clone.sourceNodeId).not.toBe('src-1');

    // The spawned source canvas node exists and matches the original's definitionId
    const spawnedSource = state.nodes.find((n) => n.id === clone.sourceNodeId);
    expect(spawnedSource).toBeDefined();
    expect(spawnedSource?.data.definitionId).toBe('text-input');
  });

  it('no-ops if the TrackItem does not exist', () => {
    seedRemotionWithItem(makeTrackItem());
    useGraphStore.getState().duplicateTrackItemAtPlayhead('r1', 'does-not-exist', 30);

    const state = useGraphStore.getState();
    expect(state.nodes).toHaveLength(2);
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline).toHaveLength(1);
  });

  it('deep-clones spatial so mutating the clone does not affect the original', () => {
    seedRemotionWithItem(makeTrackItem());
    useGraphStore.getState().duplicateTrackItemAtPlayhead('r1', 't1', 30);

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    const original = manifest.timeline.find((t) => t.id === 't1')!;
    const clone = manifest.timeline.find((t) => t.id !== 't1')!;

    expect(clone.spatial).not.toBe(original.spatial);
    expect(clone.spatial.scale).not.toBe(original.spatial.scale);
    expect(clone.spatial.rotation).not.toBe(original.spatial.rotation);

    // Mutate the clone — original must be untouched
    clone.spatial.scale[0] = 99;
    expect(original.spatial.scale[0]).toBe(1);
  });
});
