import type { Node } from '@xyflow/react';
import { TimelineRuler } from './TimelineRuler';
import { TimelineTrack } from './TimelineTrack';
import { TimelinePlayhead } from './TimelinePlayhead';
import { type EditClip, totalOutputDuration as computeTotalOutputDuration } from '../../lib/editor/virtualPlayback';
import { useUIStore } from '../../store/uiStore';

interface Props {
  editNode: Node;
  sourceUrl: string;
}

export function Timeline({ editNode, sourceUrl }: Props) {
  const params = (editNode.data as { params?: Record<string, unknown> }).params ?? {};
  const clips: EditClip[] = (params.clips as EditClip[]) ?? [];
  const sourceDuration: number = typeof params.sourceDuration === 'number' ? params.sourceDuration : 1;
  const sourceFps: number = typeof params.sourceFps === 'number' && params.sourceFps > 0 ? params.sourceFps : 30;
  const totalOutputDuration = clips.length > 0 ? computeTotalOutputDuration(clips) : sourceDuration;
  const timelineZoom = useUIStore((s) => s.timelineZoom);

  return (
    <div className="editor-tl">
      <div className="editor-tl__viewport">
        <div className="editor-tl__scroll-content" style={{ width: `${timelineZoom * 100}%` }}>
          <TimelineRuler
            sourceUrl={sourceUrl}
            sourceDuration={sourceDuration}
            totalOutputDuration={totalOutputDuration}
            sourceFps={sourceFps}
          />
          <div className="editor-tl__tracks">
            <TimelineTrack
              type="video"
              clips={clips}
              sourceDuration={sourceDuration}
              sourceFps={sourceFps}
              editNodeId={editNode.id}
            />
            <TimelineTrack
              type="audio"
              clips={clips}
              sourceDuration={sourceDuration}
              sourceFps={sourceFps}
              editNodeId={editNode.id}
              sourceUrl={sourceUrl}
            />
          </div>
          <div className="editor-tl__playhead-area">
            <TimelinePlayhead
              sourceDuration={sourceDuration}
              totalOutputDuration={totalOutputDuration}
              clips={clips}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
