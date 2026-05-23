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
