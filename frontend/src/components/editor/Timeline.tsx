import type { Node } from '@xyflow/react';
import { TimelineRuler } from './TimelineRuler';
import { TimelineTrack } from './TimelineTrack';
import { TimelinePlayhead } from './TimelinePlayhead';
import { type EditClip } from '../../lib/editor/virtualPlayback';

interface Props {
  editNode: Node;
  sourceUrl: string;
}

export function Timeline({ editNode, sourceUrl }: Props) {
  const params = (editNode.data as any).params ?? {};
  const clips: EditClip[] = params.clips ?? [];
  const sourceDuration: number = params.sourceDuration ?? 1;
  const sourceFps: number = params.sourceFps ?? 30;

  return (
    <div className="editor-tl">
      <TimelineRuler sourceUrl={sourceUrl} sourceDuration={sourceDuration} sourceFps={sourceFps} />
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
        <TimelinePlayhead sourceDuration={sourceDuration} clips={clips} />
      </div>
    </div>
  );
}
