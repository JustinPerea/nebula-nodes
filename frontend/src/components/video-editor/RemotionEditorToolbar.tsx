import { useState } from 'react';
import { Download, X } from 'lucide-react';
import { useGraphStore } from '../../store/graphStore';
import type { TrackItemOrderAction } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
import type { TrackComponentType, VideoGraphManifest } from '../../types/video';
import { backendAssetUrlSync } from '../../lib/backend';
import { startRemotionRender } from '../../lib/renderJobs';
import { useRenderJob } from '../../hooks/useRenderJob';

interface RemotionEditorToolbarProps {
  remotionNodeId: string;
}

const ADD_BUTTONS: Array<{ label: string; componentType: TrackComponentType }> = [
  { label: '+ Text', componentType: 'TextNode' },
  { label: '+ SVG', componentType: 'SVGInput' },
  { label: '+ Image', componentType: 'ImageAssetNode' },
  { label: '+ Video', componentType: 'VideoAssetNode' },
  { label: '+ Iso Block', componentType: 'IsometricBlock' },
  { label: '+ Lottie', componentType: 'LottieNode' },
];

const Z_ORDER_BUTTONS: Array<{ label: string; title: string; action: TrackItemOrderAction }> = [
  { label: 'To Back', title: 'Send selected layer to back', action: 'send-to-back' },
  { label: 'Back', title: 'Send selected layer backward', action: 'send-backward' },
  { label: 'Forward', title: 'Bring selected layer forward', action: 'bring-forward' },
  { label: 'To Front', title: 'Bring selected layer to front', action: 'bring-to-front' },
];

export function RemotionEditorToolbar({ remotionNodeId }: RemotionEditorToolbarProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const renderJob = useRenderJob();
  const addTrackItemWithCanvasMirror = useGraphStore((s) => s.addTrackItemWithCanvasMirror);
  const deleteTrackItem = useGraphStore((s) => s.deleteTrackItem);
  const reorderTrackItem = useGraphStore((s) => s.reorderTrackItem);
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);
  const setSelectedTrackItem = useUIStore((s) => s.setSelectedTrackItem);
  const isKeyframeRecording = useUIStore((s) => s.isKeyframeRecording);
  const toggleKeyframeRecording = useUIStore((s) => s.toggleKeyframeRecording);
  const selectedTrackItemIndex = useGraphStore((s) => {
    if (!selectedTrackItemId) return -1;
    const node = s.nodes.find((n) => n.id === remotionNodeId);
    const manifest = (node?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest;
    return manifest?.timeline.findIndex((t) => t.id === selectedTrackItemId) ?? -1;
  });
  const trackItemCount = useGraphStore((s) => {
    const node = s.nodes.find((n) => n.id === remotionNodeId);
    const manifest = (node?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest;
    return manifest?.timeline.length ?? 0;
  });
  const manifest = useGraphStore((s) => {
    const node = s.nodes.find((n) => n.id === remotionNodeId);
    return (node?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest;
  });

  const handleAdd = (componentType: TrackComponentType) => {
    addTrackItemWithCanvasMirror(remotionNodeId, { componentType });
  };

  const handleDelete = () => {
    if (!selectedTrackItemId) return;
    deleteTrackItem(remotionNodeId, selectedTrackItemId);
    setSelectedTrackItem(null);
  };

  const handleZOrder = (action: TrackItemOrderAction) => {
    if (!selectedTrackItemId) return;
    reorderTrackItem(remotionNodeId, selectedTrackItemId, action);
  };

  const canMoveBackward = selectedTrackItemIndex > 0;
  const canMoveForward = selectedTrackItemIndex >= 0 && selectedTrackItemIndex < trackItemCount - 1;

  return (
    <div className="remotion-editor-toolbar">
      {ADD_BUTTONS.map((btn) => (
        <button
          key={btn.componentType}
          type="button"
          className="remotion-editor-toolbar__add"
          onClick={() => handleAdd(btn.componentType)}
        >
          {btn.label}
        </button>
      ))}
      <div className="remotion-editor-toolbar__group" aria-label="Layer order controls">
        {Z_ORDER_BUTTONS.map((btn) => (
          <button
            key={btn.action}
            type="button"
            className="remotion-editor-toolbar__zorder"
            onClick={() => handleZOrder(btn.action)}
            disabled={
              btn.action === 'send-to-back' || btn.action === 'send-backward'
                ? !canMoveBackward
                : !canMoveForward
            }
            title={btn.title}
          >
            {btn.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="remotion-editor-toolbar__delete"
        onClick={handleDelete}
        disabled={!selectedTrackItemId}
      >
        Delete
      </button>
      <button
        type="button"
        className={`remotion-editor-toolbar__record ${isKeyframeRecording ? 'remotion-editor-toolbar__record--active' : ''}`}
        onClick={toggleKeyframeRecording}
        title={isKeyframeRecording ? 'Recording keyframes - click to stop' : 'Click to record keyframes on drag'}
      >
        ● REC
      </button>
      <div className="final-export final-export--remotion">
        <button
          type="button"
          className="remotion-editor-toolbar__export"
          onClick={() => setExportOpen((open) => !open)}
        >
          <Download size={14} aria-hidden="true" /> Export
        </button>
        {exportOpen && (
          <div className="final-export__popover" role="dialog" aria-label="Remotion H.264 export">
            <div className="final-export__header">
              <strong>Remotion export</strong>
              <button type="button" onClick={() => setExportOpen(false)} aria-label="Close export">
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <div className="final-export__summary">MP4 · H.264 · 1280×720 · 30 fps</div>
            {renderJob.job?.status === 'running' ? (
              <div className="final-export__progress">
                <progress max={1} value={renderJob.job.progress} />
                <span>{Math.round(renderJob.job.progress * 100)}%</span>
                <button type="button" onClick={() => void renderJob.cancel()}>Cancel</button>
              </div>
            ) : renderJob.job?.status === 'complete' && renderJob.job.outputUrl ? (
              <div className="final-export__actions">
                <a className="final-export__download" href={backendAssetUrlSync(renderJob.job.outputUrl)} download>
                  <Download size={14} aria-hidden="true" /> Download MP4
                </a>
                <button type="button" onClick={renderJob.reset}>New render</button>
              </div>
            ) : (
              <button
                type="button"
                className="final-export__start"
                disabled={!manifest}
                onClick={() => manifest && void renderJob.begin(() => startRemotionRender(manifest))}
              >
                Render MP4
              </button>
            )}
            {(renderJob.error || renderJob.job?.error) && (
              <div className="final-export__error" role="alert">{renderJob.error || renderJob.job?.error}</div>
            )}
            {renderJob.job?.status === 'cancelled' && (
              <div className="final-export__status">Export cancelled.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
