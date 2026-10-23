import { useEffect, useRef, useState } from 'react';
import { WorkspaceHeader } from '../WorkspaceHeader';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { EditorBreadcrumb } from './EditorBreadcrumb';
import { VideoPreview } from './VideoPreview';
import { EditorTransport } from './EditorTransport';
import { Timeline } from './Timeline';
import { useBottomBarClearance } from '../../hooks/useBottomBarClearance';
import './EditorView.css';

export function EditorView() {
  const editorTargetNodeId = useUIStore((s) => s.editorTargetNodeId);
  const exitEditor = useUIStore((s) => s.exitEditor);
  const setSelectedClip = useUIStore((s) => s.setSelectedClip);
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);

  const [tooSmall, setTooSmall] = useState(typeof window !== 'undefined' && window.innerWidth < 1280);
  useEffect(() => {
    const onResize = () => setTooSmall(window.innerWidth < 1280);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const editNode = editorTargetNodeId ? nodes.find((n) => n.id === editorTargetNodeId) : null;
  const sourceEdge = editNode
    ? edges.find((e) => e.target === editNode.id && e.targetHandle === 'video_in')
    : null;
  const sourceNode = sourceEdge ? nodes.find((n) => n.id === sourceEdge.source) : null;
  const sourceUrl = (() => {
    if (!sourceNode) return null;
    const outputs = (sourceNode.data.outputs ?? {}) as Record<string, { type: string; value: string }>;
    const videoOut = Object.values(outputs).find((o) => o.type === 'Video');
    return videoOut?.value ?? null;
  })();

  // The transport row and the timeline are this screen's bottom bar: both
  // publish their top edge, so the app's notices sit 8 px above the
  // transport, over the preview's bottom edge (GM - Design, 2026-10-23, round
  // 4: "A notice should never sit over a timeline being edited, even one that
  // shares its column."; round 4b: "publish the transport's top edge as well,
  // so notices sit over the preview's bottom edge. Cut, Vol and zoom are
  // being used while someone edits."). Measured again when either changes
  // size (the transport wraps to two rows when a clip is selected), on a
  // resize, and when they come or go; the empty editor has neither.
  const transportRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const hasTimeline = Boolean(editNode && sourceNode && sourceUrl);
  useBottomBarClearance([transportRef, timelineRef], hasTimeline);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      // Bail out of all bindings if the user is typing in a form field.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }

      // Always-available bindings (work whether or not an edit node is loaded).
      if (e.key === 'Escape') {
        e.preventDefault();
        const ui = useUIStore.getState();
        if (ui.selectedClipId) setSelectedClip(null);
        else exitEditor();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        useUIStore.getState().zoomTimelineIn();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '-') {
        e.preventDefault();
        useUIStore.getState().zoomTimelineOut();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault();
        useUIStore.getState().resetTimelineZoom();
        return;
      }

      // Editor-context bindings (only when we have an edit node loaded).
      if (!editNode) return;
      const ui = useUIStore.getState();
      const graph = useGraphStore.getState();

      // Cut at playhead — bare B (Blade, matching FCPX + DaVinci Resolve)
      // or ⌘K / Ctrl+K (Premiere's "Add Edit"). Bare S was the original
      // binding but collides with too many established single-key shortcuts
      // (select tool, snap toggle, etc.). B is the safest NLE convention.
      if (
        (e.key === 'b' || e.key === 'B') && !e.metaKey && !e.ctrlKey && !e.altKey
      ) {
        e.preventDefault();
        const srcT = (window as Window & { __editorPlayheadSourceTime?: number }).__editorPlayheadSourceTime ?? 0;
        graph.cutEditNodeAtSource(editNode.id, srcT);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        const srcT = (window as Window & { __editorPlayheadSourceTime?: number }).__editorPlayheadSourceTime ?? 0;
        graph.cutEditNodeAtSource(editNode.id, srcT);
        return;
      }

      // Delete selected clip — Backspace or Delete
      if ((e.key === 'Backspace' || e.key === 'Delete') && ui.selectedClipId) {
        e.preventDefault();
        graph.removeEditNodeClip(editNode.id, ui.selectedClipId);
        setSelectedClip(null);
        return;
      }

      // Mute toggle — bare M
      if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (!ui.selectedClipId) return;
        e.preventDefault();
        const params = (editNode.data as { params?: Record<string, unknown> }).params ?? {};
        const clips = (params.clips as Array<{ id: string; mute: boolean }>) ?? [];
        const clip = clips.find((c) => c.id === ui.selectedClipId);
        if (clip) graph.updateEditNodeClip(editNode.id, clip.id, { mute: !clip.mute });
        return;
      }

      // Set in/out at playhead — bare I or O
      // Keep speed constant; recompute duration from new source range.
      if (
        (e.key === 'i' || e.key === 'I' || e.key === 'o' || e.key === 'O') &&
        !e.metaKey && !e.ctrlKey && !e.altKey
      ) {
        if (!ui.selectedClipId) return;
        e.preventDefault();
        const srcT = (window as Window & { __editorPlayheadSourceTime?: number }).__editorPlayheadSourceTime ?? 0;
        const params = (editNode.data as { params?: Record<string, unknown> }).params ?? {};
        const clips = (params.clips as Array<{
          id: string;
          duration: number;
          sourceIn: number;
          sourceOut: number;
        }>) ?? [];
        const clip = clips.find((c) => c.id === ui.selectedClipId);
        if (!clip) return;
        const speed = clip.duration > 0 ? (clip.sourceOut - clip.sourceIn) / clip.duration : 1;
        if (e.key === 'i' || e.key === 'I') {
          // Set sourceIn to playhead's source-time; clamp [0, sourceOut - epsilon]
          const newSourceIn = Math.max(0, Math.min(srcT, clip.sourceOut - 0.001));
          const newDuration = (clip.sourceOut - newSourceIn) / speed;
          graph.updateEditNodeClip(editNode.id, clip.id, { sourceIn: newSourceIn, duration: newDuration });
        } else {
          // Set sourceOut to playhead's source-time; clamp [sourceIn + epsilon, ∞)
          const newSourceOut = Math.max(clip.sourceIn + 0.001, srcT);
          const newDuration = (newSourceOut - clip.sourceIn) / speed;
          graph.updateEditNodeClip(editNode.id, clip.id, { sourceOut: newSourceOut, duration: newDuration });
        }
        return;
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [exitEditor, setSelectedClip, editNode]);

  if (!editNode || !sourceNode || !sourceUrl) {
    return (
      <div className="editor-view editor-view--empty">
        <WorkspaceHeader title="Video editor" onBack={exitEditor} />
        <p className="editor-view__empty-message">Connect a video upstream to edit.</p>
      </div>
    );
  }

  return (
    <div className="editor-view">
      <WorkspaceHeader title="Video editor" onBack={exitEditor} />
      {tooSmall && (
        <div className="editor-view__too-small">
          Best viewed at ≥ 1280px wide. Some controls may be cramped.
        </div>
      )}
      <EditorBreadcrumb sourceNode={sourceNode} editNode={editNode} />
      <VideoPreview sourceUrl={sourceUrl} editNode={editNode} />
      <EditorTransport ref={transportRef} editNode={editNode} sourceUrl={sourceUrl} />
      <Timeline ref={timelineRef} editNode={editNode} sourceUrl={sourceUrl} />
    </div>
  );
}
