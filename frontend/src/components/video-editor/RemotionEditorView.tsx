import { useRef } from 'react';
import { Player } from '@remotion/player';
import type { PlayerRef } from '@remotion/player';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { createEmptyManifest, DEFAULT_FPS, type VideoGraphManifest } from '../../types/video';
import { RemotionComposition } from './RemotionComposition';
import '../../styles/remotion-editor.css';

export function RemotionEditorView() {
  const playerRef = useRef<PlayerRef>(null);
  const targetNodeId = useUIStore((s) => s.remotionEditorTargetNodeId);
  const exitRemotionEditor = useUIStore((s) => s.exitRemotionEditor);
  const node = useGraphStore((s) =>
    targetNodeId ? s.nodes.find((n) => n.id === targetNodeId) : null,
  );

  if (!targetNodeId || !node) {
    return (
      <div className="remotion-editor-view">
        <div className="remotion-editor-view__empty-state">
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
        <Player
          ref={playerRef}
          component={RemotionComposition}
          inputProps={{ manifest }}
          durationInFrames={Math.max(
            DEFAULT_FPS * 5,
            ...manifest.timeline.map(
              (i) => i.time.startFrame + i.time.durationInFrames,
            ),
            DEFAULT_FPS,
          )}
          compositionWidth={1280}
          compositionHeight={720}
          fps={DEFAULT_FPS}
          controls
          loop
          style={{ width: '100%', maxWidth: 1280, aspectRatio: '16 / 9' }}
          acknowledgeRemotionLicense
        />
      </div>
      <div className="remotion-editor-view__timeline" data-testid="remotion-timeline-slot">
        {/* Timeline mounts here in T13 */}
      </div>
    </div>
  );
}
