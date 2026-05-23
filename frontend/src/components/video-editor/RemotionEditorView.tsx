import { useRef, useEffect, useState } from 'react';
import { Player } from '@remotion/player';
import type { PlayerRef } from '@remotion/player';
import { RemotionTimeline } from './RemotionTimeline';
import type { TimelineState } from './RemotionTimeline';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { createEmptyManifest, DEFAULT_FPS, type VideoGraphManifest } from '../../types/video';
import { RemotionComposition } from './RemotionComposition';
import { RemotionEditorToolbar } from './RemotionEditorToolbar';
import { RemotionPropertiesPanel } from './RemotionPropertiesPanel';
import { PlayerOverlay } from './PlayerOverlay';
import { useRemotionKeyboard } from './useRemotionKeyboard';
import '../../styles/remotion-editor.css';

export function RemotionEditorView() {
  const playerRef = useRef<PlayerRef>(null);
  const playerFrameRef = useRef<HTMLDivElement>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const timelineStateRef = useRef<TimelineState | null>(null);
  const targetNodeId = useUIStore((s) => s.remotionEditorTargetNodeId);
  const exitRemotionEditor = useUIStore((s) => s.exitRemotionEditor);
  const node = useGraphStore((s) =>
    targetNodeId ? s.nodes.find((n) => n.id === targetNodeId) : null,
  );

  // Keyboard shortcuts (Delete, Cmd+D). Hook is no-op when targetNodeId is null.
  useRemotionKeyboard({
    remotionNodeId: targetNodeId ?? '',
    currentFrame,
  });

  // Sync Player playback position → currentFrame state.
  // frameupdate fires every rendered frame with { detail: { frame } }.
  // We call getCurrentFrame() instead of reading the event payload to stay
  // type-safe without casting the generic CallbackListener signature.
  // Must be declared before any conditional return to satisfy Rules of Hooks.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const handler = () => {
      const frame = player.getCurrentFrame();
      setCurrentFrame(frame);
      // Drive the xzdarcy timeline cursor to match the Player's current frame.
      timelineStateRef.current?.setTime(frame / DEFAULT_FPS);
    };
    player.addEventListener('frameupdate', handler);
    return () => player.removeEventListener('frameupdate', handler);
  }, []); // empty — runs once after mount; playerRef.current is stable post-mount

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const automation = {
      seekToFrame: (frame: number) => {
        playerRef.current?.seekTo(frame);
        setCurrentFrame(frame);
        timelineStateRef.current?.setTime(frame / DEFAULT_FPS);
      },
      getCurrentFrame: () => currentFrame,
    };
    (window as unknown as { __nebulaRemotionEditor?: typeof automation }).__nebulaRemotionEditor = automation;
    return () => {
      const w = window as unknown as { __nebulaRemotionEditor?: typeof automation };
      if (w.__nebulaRemotionEditor === automation) {
        delete w.__nebulaRemotionEditor;
      }
    };
  }, [currentFrame]);

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
    <div className="remotion-editor-view" data-current-frame={currentFrame}>
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
        <RemotionEditorToolbar remotionNodeId={targetNodeId} />
        <span className="remotion-editor-view__meta">
          {manifest.timeline.length} layer{manifest.timeline.length === 1 ? '' : 's'}
        </span>
      </header>
      <div className="remotion-editor-view__player" data-testid="remotion-player-slot">
        <div className="remotion-editor-view__player-frame" ref={playerFrameRef}>
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
          <PlayerOverlay
            remotionNodeId={targetNodeId}
            playerFrameRef={playerFrameRef}
            currentFrame={currentFrame}
          />
        </div>
      </div>
      <aside className="remotion-editor-view__panel" data-testid="remotion-panel-slot">
        <RemotionPropertiesPanel remotionNodeId={targetNodeId} />
      </aside>
      <div className="remotion-editor-view__timeline" data-testid="remotion-timeline-slot">
        <RemotionTimeline
          remotionNodeId={targetNodeId}
          manifest={manifest}
          currentFrame={currentFrame}
          onScrub={(frame) => playerRef.current?.seekTo(frame)}
          timelineState={timelineStateRef}
        />
      </div>
    </div>
  );
}
