import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { EditorBreadcrumb } from './EditorBreadcrumb';
import { VideoPreview } from './VideoPreview';
import { EditorTransport } from './EditorTransport';
import { Timeline } from './Timeline';
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

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // Bail out of all bindings if the user is typing in a form field.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
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
        <p>Connect a video upstream to edit.</p>
        <button type="button" onClick={exitEditor}>
          <ArrowLeft className="editor-view__button-icon" aria-hidden="true" focusable="false" />
          <span>Back to Canvas</span>
        </button>
      </div>
    );
  }

  return (
    <div className="editor-view">
      {tooSmall && (
        <div className="editor-view__too-small">
          Best viewed at ≥ 1280px wide. Some controls may be cramped.
        </div>
      )}
      <EditorBreadcrumb sourceNode={sourceNode} editNode={editNode} />
      <VideoPreview sourceUrl={sourceUrl} editNode={editNode} />
      <EditorTransport editNode={editNode} sourceUrl={sourceUrl} />
      <Timeline editNode={editNode} sourceUrl={sourceUrl} />
    </div>
  );
}
