import type { Ref } from 'react';
import type { Node } from '@xyflow/react';
import { TimelineRuler } from './TimelineRuler';
import { TimelineTrack } from './TimelineTrack';
import { TimelinePlayhead } from './TimelinePlayhead';
import { type EditClip, totalOutputDuration as computeTotalOutputDuration } from '../../lib/editor/virtualPlayback';
import { useUIStore } from '../../store/uiStore';

interface Props {
  editNode: Node;
  sourceUrl: string;
  /** The timeline's box, for the editor's bottom-bar clearance (EditorView). */
  ref?: Ref<HTMLDivElement>;
}

/** The trim editor's timeline. With the transport row above it, it is the
 * screen's bottom bar (`data-bottom-bar`): EditorView publishes their top
 * edge, so the app's notices never sit over it (GM - Design, round 4: "A
 * notice should never sit over a timeline being edited, even one that shares
 * its column."; round 4b: the transport publishes too, so notices sit above
 * it, over the preview's bottom edge). */
export function Timeline({ editNode, sourceUrl, ref }: Props) {
  const params = (editNode.data as { params?: Record<string, unknown> }).params ?? {};
  const clips: EditClip[] = (params.clips as EditClip[]) ?? [];
  const sourceDuration: number = typeof params.sourceDuration === 'number' ? params.sourceDuration : 1;
  const sourceFps: number = typeof params.sourceFps === 'number' && params.sourceFps > 0 ? params.sourceFps : 30;
  const totalOutputDuration = clips.length > 0 ? computeTotalOutputDuration(clips) : sourceDuration;
  const timelineZoom = useUIStore((s) => s.timelineZoom);

  return (
    <div ref={ref} className="editor-tl" data-bottom-bar="">
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
