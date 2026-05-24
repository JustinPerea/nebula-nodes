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

function seedRemotionWithItem(trackItem: TrackItem, remotionId = 'r1') {
  const remotionNode = {
    id: remotionId,
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
  useGraphStore.setState({ nodes: [remotionNode as never, sourceNode as never], undoStack: [], redoStack: [] });
}

function seedRemotionWithTimeline(trackItems: TrackItem[], remotionId = 'r1') {
  const remotionNode = {
    id: remotionId,
    type: 'remotionNode',
    position: { x: 0, y: 0 },
    data: {
      definitionId: 'remotion-node',
      label: 'R',
      params: {
        manifest: { graph: { nodes: [], edges: [] }, timeline: trackItems },
      },
      state: 'idle' as const,
      outputs: {},
    },
  };
  useGraphStore.setState({ nodes: [remotionNode as never], undoStack: [], redoStack: [] });
}

function readTimelineIds(remotionId = 'r1'): string[] {
  const state = useGraphStore.getState();
  const remotion = state.nodes.find((n) => n.id === remotionId);
  const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
  return manifest.timeline.map((t) => t.id);
}

describe('graphStore — updateTrackItemSpatial', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('shallow-merges spatialPatch into the existing spatial', () => {
    seedRemotionWithItem(makeTrackItem({
      spatial: { x: 10, y: 20, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] },
    }));
    useGraphStore.getState().updateTrackItemSpatial('r1', 't1', { x: 100 });

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(100);
    expect(manifest.timeline[0].spatial.y).toBe(20); // preserved
    expect(manifest.timeline[0].spatial.z).toBe(0);  // preserved
    expect(manifest.timeline[0].spatial.scale).toEqual([1, 1, 1]); // preserved
  });

  it('preserves scale and rotation when only x/y change', () => {
    seedRemotionWithItem(makeTrackItem({
      spatial: { x: 0, y: 0, z: 0, scale: [2, 2, 2], rotation: [0, 90, 0] },
    }));
    useGraphStore.getState().updateTrackItemSpatial('r1', 't1', { x: 50, y: -25 });

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.scale).toEqual([2, 2, 2]);
    expect(manifest.timeline[0].spatial.rotation).toEqual([0, 90, 0]);
  });

  it('no-ops if the TrackItem does not exist', () => {
    seedRemotionWithItem(makeTrackItem());
    useGraphStore.getState().updateTrackItemSpatial('r1', 'does-not-exist', { x: 999 });

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(0);
  });

  it('no-ops if the RemotionNode does not exist', () => {
    useGraphStore.getState().updateTrackItemSpatial('does-not-exist', 't1', { x: 999 });
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('debounces rapid same-node patches into one undo entry', () => {
    seedRemotionWithItem(makeTrackItem(), 'r-undo-test');
    const undoBefore = useGraphStore.getState().undoStack.length;

    // Three rapid patches on the same remotion node within the 500ms window
    useGraphStore.getState().updateTrackItemSpatial('r-undo-test', 't1', { x: 10 });
    useGraphStore.getState().updateTrackItemSpatial('r-undo-test', 't1', { x: 20 });
    useGraphStore.getState().updateTrackItemSpatial('r-undo-test', 't1', { x: 30 });

    const undoAfter = useGraphStore.getState().undoStack.length;
    // maybePushUndo should have added exactly one entry (on the first call)
    expect(undoAfter).toBe(undoBefore + 1);

    // Final value still reflects the last patch
    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r-undo-test');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial.x).toBe(30);

    // Undo should restore the state before the first patch (x: 0)
    state.undo();
    const stateAfterUndo = useGraphStore.getState();
    const remotionAfterUndo = stateAfterUndo.nodes.find((n) => n.id === 'r-undo-test');
    const manifestAfterUndo = (remotionAfterUndo?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifestAfterUndo.timeline[0].spatial.x).toBe(0);
  });
});

describe('graphStore — reorderTrackItem', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('moves a selected TrackItem one layer forward', () => {
    seedRemotionWithTimeline([
      makeTrackItem({ id: 'back' }),
      makeTrackItem({ id: 'middle' }),
      makeTrackItem({ id: 'front' }),
    ]);

    useGraphStore.getState().reorderTrackItem('r1', 'middle', 'bring-forward');

    expect(readTimelineIds()).toEqual(['back', 'front', 'middle']);
  });

  it('sends a selected TrackItem to back and brings it to front', () => {
    seedRemotionWithTimeline([
      makeTrackItem({ id: 'a' }),
      makeTrackItem({ id: 'b' }),
      makeTrackItem({ id: 'c' }),
      makeTrackItem({ id: 'd' }),
    ]);

    useGraphStore.getState().reorderTrackItem('r1', 'c', 'send-to-back');
    expect(readTimelineIds()).toEqual(['c', 'a', 'b', 'd']);

    useGraphStore.getState().reorderTrackItem('r1', 'c', 'bring-to-front');
    expect(readTimelineIds()).toEqual(['a', 'b', 'd', 'c']);
  });

  it('does not push undo for endpoint no-ops', () => {
    seedRemotionWithTimeline([
      makeTrackItem({ id: 'a' }),
      makeTrackItem({ id: 'b' }),
    ]);

    useGraphStore.getState().reorderTrackItem('r1', 'a', 'send-backward');

    expect(readTimelineIds()).toEqual(['a', 'b']);
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
  });

  it('pushes an undo snapshot for real order changes', () => {
    seedRemotionWithTimeline([
      makeTrackItem({ id: 'a' }),
      makeTrackItem({ id: 'b' }),
    ]);

    const state = useGraphStore.getState();
    state.reorderTrackItem('r1', 'a', 'bring-to-front');
    expect(readTimelineIds()).toEqual(['b', 'a']);

    useGraphStore.getState().undo();
    expect(readTimelineIds()).toEqual(['a', 'b']);
  });
});

describe('graphStore — addOrUpdateKeyframe', () => {
  beforeEach(() => {
    useGraphStore.setState(INITIAL_GRAPH_STATE, true);
  });

  it('inserts a new keyframe array for a missing prop', () => {
    seedRemotionWithItem(makeTrackItem());
    useGraphStore.getState().addOrUpdateKeyframe('r1', 't1', 'position', 30, [100, 50, 0]);

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].keyframes.position).toEqual([
      { frame: 30, value: [100, 50, 0], easing: 'linear' },
    ]);
  });

  it('replaces an existing keyframe at the same rounded frame', () => {
    seedRemotionWithItem(makeTrackItem({
      keyframes: {
        position: [
          { frame: 30, value: [1, 2, 3], easing: 'spring' },
        ],
      },
    }));
    useGraphStore.getState().addOrUpdateKeyframe('r1', 't1', 'position', 30.4, [4, 5, 6]);

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].keyframes.position).toEqual([
      { frame: 30, value: [4, 5, 6], easing: 'linear' },
    ]);
  });

  it('keeps keyframes sorted by frame', () => {
    seedRemotionWithItem(makeTrackItem({
      keyframes: {
        position: [
          { frame: 40, value: [40, 0, 0], easing: 'linear' },
          { frame: 10, value: [10, 0, 0], easing: 'linear' },
        ],
      },
    }));
    useGraphStore.getState().addOrUpdateKeyframe('r1', 't1', 'position', 25, [25, 0, 0]);

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].keyframes.position.map((k) => k.frame)).toEqual([10, 25, 40]);
  });

  it('no-ops if the TrackItem does not exist', () => {
    seedRemotionWithItem(makeTrackItem());
    useGraphStore.getState().addOrUpdateKeyframe('r1', 'does-not-exist', 'position', 30, [1, 2, 3]);

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].keyframes).toEqual({});
  });

  it('no-ops if the RemotionNode does not exist', () => {
    useGraphStore.getState().addOrUpdateKeyframe('does-not-exist', 't1', 'position', 30, [1, 2, 3]);
    expect(useGraphStore.getState().nodes).toHaveLength(0);
  });

  it('does not mutate static spatial values', () => {
    seedRemotionWithItem(makeTrackItem({
      spatial: { x: 10, y: 20, z: 30, scale: [2, 3, 4], rotation: [5, 6, 7] },
    }));
    useGraphStore.getState().addOrUpdateKeyframe('r1', 't1', 'position', 30, [100, 200, 300]);

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r1');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].spatial).toEqual({
      x: 10,
      y: 20,
      z: 30,
      scale: [2, 3, 4],
      rotation: [5, 6, 7],
    });
  });

  it('debounces rapid same-node keyframe updates into one undo entry', () => {
    seedRemotionWithItem(makeTrackItem(), 'r-keyframe-undo');
    const undoBefore = useGraphStore.getState().undoStack.length;

    useGraphStore.getState().addOrUpdateKeyframe('r-keyframe-undo', 't1', 'position', 10, [10, 0, 0]);
    useGraphStore.getState().addOrUpdateKeyframe('r-keyframe-undo', 't1', 'position', 20, [20, 0, 0]);
    useGraphStore.getState().addOrUpdateKeyframe('r-keyframe-undo', 't1', 'position', 30, [30, 0, 0]);

    const undoAfter = useGraphStore.getState().undoStack.length;
    expect(undoAfter).toBe(undoBefore + 1);

    const state = useGraphStore.getState();
    const remotion = state.nodes.find((n) => n.id === 'r-keyframe-undo');
    const manifest = (remotion?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifest.timeline[0].keyframes.position).toHaveLength(3);

    state.undo();
    const stateAfterUndo = useGraphStore.getState();
    const remotionAfterUndo = stateAfterUndo.nodes.find((n) => n.id === 'r-keyframe-undo');
    const manifestAfterUndo = (remotionAfterUndo?.data.params as { manifest: { timeline: TrackItem[] } }).manifest;
    expect(manifestAfterUndo.timeline[0].keyframes).toEqual({});
  });
});
