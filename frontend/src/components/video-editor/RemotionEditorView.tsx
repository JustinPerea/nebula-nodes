import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { createEmptyManifest, type VideoGraphManifest } from '../../types/video';
import '../../styles/remotion-editor.css';

export function RemotionEditorView() {
  const targetNodeId = useUIStore((s) => s.remotionEditorTargetNodeId);
  const exitRemotionEditor = useUIStore((s) => s.exitRemotionEditor);
  const node = useGraphStore((s) =>
    targetNodeId ? s.nodes.find((n) => n.id === targetNodeId) : null,
  );

  if (!targetNodeId || !node) {
    return (
      <div className="remotion-editor-view">
        <div className="remotion-editor-view__error">
          No RemotionNode selected.{' '}
          <button type="button" onClick={exitRemotionEditor}>
            Back to canvas
          </button>
        </div>
      </div>
    );
  }

  const manifest: VideoGraphManifest =
    (node.data as { params?: { manifest?: VideoGraphManifest } }).params?.manifest ??
    createEmptyManifest();

  return (
    <div className="remotion-editor-view">
      <header className="remotion-editor-view__header">
        <button
          type="button"
          className="remotion-editor-view__back"
          onClick={exitRemotionEditor}
        >
          ← Canvas
        </button>
        <span className="remotion-editor-view__title">
          Remotion Composition · {targetNodeId}
        </span>
        <span className="remotion-editor-view__meta">
          {manifest.timeline.length} layer{manifest.timeline.length === 1 ? '' : 's'}
        </span>
      </header>
      <div className="remotion-editor-view__player" data-testid="remotion-player-slot">
        {/* Player mounts here in T12 */}
      </div>
      <div className="remotion-editor-view__timeline" data-testid="remotion-timeline-slot">
        {/* Timeline mounts here in T13 */}
      </div>
    </div>
  );
}
