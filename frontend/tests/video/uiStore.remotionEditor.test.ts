import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../../src/store/uiStore';

// Capture the full initial store state so beforeEach can do a hard replace
// (Zustand replace flag = true) rather than a partial merge. This prevents any
// field set in one test (editorTargetNodeId, isPlaying, selectedClipId, etc.)
// from bleeding into the next.
const INITIAL_STATE = { ...useUIStore.getState() };

describe('uiStore — RemotionEditor lifecycle', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_STATE, true);
  });

  it('enterRemotionEditor sets viewMode and target node id', () => {
    useUIStore.getState().enterRemotionEditor('remotion-1');
    const state = useUIStore.getState();
    expect(state.viewMode).toBe('remotion-editor');
    expect(state.remotionEditorTargetNodeId).toBe('remotion-1');
  });

  it('exitRemotionEditor resets to canvas viewMode', () => {
    useUIStore.getState().enterRemotionEditor('remotion-1');
    useUIStore.getState().exitRemotionEditor();
    const state = useUIStore.getState();
    expect(state.viewMode).toBe('canvas');
    expect(state.remotionEditorTargetNodeId).toBeNull();
  });

  it('enterRemotionEditor does not affect Phase 1 editor state', () => {
    useUIStore.setState({ editorTargetNodeId: 'edit-1' });
    useUIStore.getState().enterRemotionEditor('remotion-1');
    expect(useUIStore.getState().editorTargetNodeId).toBe('edit-1');
  });
});

describe('uiStore — TrackItem selection', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_STATE, true);
  });

  it('setSelectedTrackItem stores the id', () => {
    useUIStore.getState().setSelectedTrackItem('track-1');
    expect(useUIStore.getState().selectedTrackItemId).toBe('track-1');
    expect(useUIStore.getState().selectedTrackItemIds).toEqual(['track-1']);
  });

  it('setSelectedTrackItem(null) clears the selection', () => {
    useUIStore.setState({ selectedTrackItemId: 'track-1', selectedTrackItemIds: ['track-1'] });
    useUIStore.getState().setSelectedTrackItem(null);
    expect(useUIStore.getState().selectedTrackItemId).toBeNull();
    expect(useUIStore.getState().selectedTrackItemIds).toEqual([]);
  });

  it('setSelectedTrackItems stores a unique selection list and primary id', () => {
    useUIStore.getState().setSelectedTrackItems(['track-1', 'track-2', 'track-1'], 'track-2');
    expect(useUIStore.getState().selectedTrackItemId).toBe('track-2');
    expect(useUIStore.getState().selectedTrackItemIds).toEqual(['track-1', 'track-2']);
  });

  it('toggleSelectedTrackItem adds and removes ids while keeping a primary selection', () => {
    useUIStore.getState().setSelectedTrackItem('track-1');
    useUIStore.getState().toggleSelectedTrackItem('track-2');
    expect(useUIStore.getState().selectedTrackItemId).toBe('track-2');
    expect(useUIStore.getState().selectedTrackItemIds).toEqual(['track-1', 'track-2']);

    useUIStore.getState().toggleSelectedTrackItem('track-2');
    expect(useUIStore.getState().selectedTrackItemId).toBe('track-1');
    expect(useUIStore.getState().selectedTrackItemIds).toEqual(['track-1']);
  });

  it('exitRemotionEditor also clears selectedTrackItemId', () => {
    useUIStore.setState({
      viewMode: 'remotion-editor',
      remotionEditorTargetNodeId: 'r1',
      selectedTrackItemId: 'track-1',
      selectedTrackItemIds: ['track-1', 'track-2'],
    });
    useUIStore.getState().exitRemotionEditor();
    expect(useUIStore.getState().selectedTrackItemId).toBeNull();
    expect(useUIStore.getState().selectedTrackItemIds).toEqual([]);
  });
});

describe('uiStore — keyframe recording', () => {
  beforeEach(() => {
    useUIStore.setState(INITIAL_STATE, true);
  });

  it('isKeyframeRecording defaults to false', () => {
    expect(useUIStore.getState().isKeyframeRecording).toBe(false);
  });

  it('toggleKeyframeRecording flips the field', () => {
    useUIStore.getState().toggleKeyframeRecording();
    expect(useUIStore.getState().isKeyframeRecording).toBe(true);
    useUIStore.getState().toggleKeyframeRecording();
    expect(useUIStore.getState().isKeyframeRecording).toBe(false);
  });

  it('exitRemotionEditor resets isKeyframeRecording to false', () => {
    useUIStore.setState({
      viewMode: 'remotion-editor',
      remotionEditorTargetNodeId: 'r1',
      isKeyframeRecording: true,
    });
    useUIStore.getState().exitRemotionEditor();
    expect(useUIStore.getState().isKeyframeRecording).toBe(false);
  });
});
