import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../../src/store/uiStore';

describe('uiStore — RemotionEditor lifecycle', () => {
  beforeEach(() => {
    useUIStore.setState({
      viewMode: 'canvas',
      remotionEditorTargetNodeId: null,
    });
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
