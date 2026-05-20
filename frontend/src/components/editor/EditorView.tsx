import { useEffect, useState } from 'react';
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
      if (e.key === 'Escape') {
        e.preventDefault();
        const ui = useUIStore.getState();
        if (ui.selectedClipId) setSelectedClip(null);
        else exitEditor();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [exitEditor, setSelectedClip]);

  if (!editNode || !sourceNode || !sourceUrl) {
    return (
      <div className="editor-view editor-view--empty">
        <p>Connect a video upstream to edit.</p>
        <button type="button" onClick={exitEditor}>Back to Canvas</button>
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
