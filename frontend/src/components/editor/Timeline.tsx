import type { Node } from '@xyflow/react';
import { TimelineRuler } from './TimelineRuler';
import { TimelineTrack } from './TimelineTrack';
import { TimelinePlayhead } from './TimelinePlayhead';
import { type EditClip, totalOutputDuration as computeTotalOutputDuration } from '../../lib/editor/virtualPlayback';

interface Props {
  editNode: Node;
  sourceUrl: string;
}

export function Timeline({ editNode, sourceUrl }: Props) {
  const params = (editNode.data as { params?: Record<string, unknown> }).params ?? {};
  const clips: EditClip[] = (params.clips as EditClip[]) ?? [];
  const sourceDuration: number = typeof params.sourceDuration === 'number' ? params.sourceDuration : 1;
  const sourceFps: number = typeof params.sourceFps === 'number' && params.sourceFps > 0 ? params.sourceFps : 30;
  // totalOutputDuration is the OUTPUT timeline range — what the ruler, clip
  // bars, and playhead all measure against. Falls back to sourceDuration when
  // there are no clips yet so the empty editor still renders a sensible ruler.
  const totalOutputDuration = clips.length > 0 ? computeTotalOutputDuration(clips) : sourceDuration;

  return (
    <div className="editor-tl">
      <TimelineRuler
        sourceUrl={sourceUrl}
        totalOutputDuration={totalOutputDuration}
        sourceDuration={sourceDuration}
        sourceFps={sourceFps}
      />
      <div className="editor-tl__tracks">
        <TimelineTrack
          type="video"
          clips={clips}
          totalOutputDuration={totalOutputDuration}
          sourceFps={sourceFps}
          editNodeId={editNode.id}
        />
        <TimelineTrack
          type="audio"
          clips={clips}
          totalOutputDuration={totalOutputDuration}
          sourceFps={sourceFps}
          editNodeId={editNode.id}
          sourceUrl={sourceUrl}
        />
      </div>
      <div className="editor-tl__playhead-area">
        <TimelinePlayhead totalOutputDuration={totalOutputDuration} clips={clips} />
      </div>
    </div>
  );
}
