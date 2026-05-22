import { useMemo } from 'react';
import { Timeline as XzdarcyTimeline } from '@xzdarcy/react-timeline-editor';
import type { TimelineState } from '@xzdarcy/react-timeline-editor/dist/interface/timeline';
import type {
  TimelineRow,
  TimelineAction,
  TimelineEffect,
} from '@xzdarcy/timeline-engine';
import type { VideoGraphManifest, TrackItem } from '../../types/video';
import { DEFAULT_FPS } from '../../types/video';

interface RemotionTimelineProps {
  manifest: VideoGraphManifest;
  currentFrame: number;
  onScrub: (frame: number) => void;
  timelineState: React.RefObject<TimelineState | null>;
}

function manifestToEditorData(manifest: VideoGraphManifest): TimelineRow[] {
  return manifest.timeline.map((item: TrackItem) => ({
    id: item.id,
    actions: [
      {
        id: item.id,
        start: item.time.startFrame / DEFAULT_FPS,
        end: (item.time.startFrame + item.time.durationInFrames) / DEFAULT_FPS,
        effectId: item.componentType,
        flexible: true,
        movable: true,
      } as TimelineAction,
    ],
  }));
}

// One effect per componentType — purely cosmetic (controls bar color).
const EFFECTS: Record<string, TimelineEffect> = {
  TextNode: { id: 'TextNode', name: 'Text' },
  SVGInput: { id: 'SVGInput', name: 'SVG' },
  ImageAssetNode: { id: 'ImageAssetNode', name: 'Image' },
  VideoAssetNode: { id: 'VideoAssetNode', name: 'Video' },
  IsometricBlock: { id: 'IsometricBlock', name: '3D Block' },
  LottieNode: { id: 'LottieNode', name: 'Lottie' },
};

export function RemotionTimeline({
  manifest,
  onScrub,
  timelineState,
}: RemotionTimelineProps) {
  const editorData = useMemo(() => manifestToEditorData(manifest), [manifest]);

  return (
    <XzdarcyTimeline
      ref={timelineState}
      editorData={editorData}
      effects={EFFECTS}
      autoScroll
      onChange={() => {
        // Mutation routing (drag-to-trim, drag-to-move) lands in Plan 2.1.b.
        // For Phase 2.1.a the timeline is read-only — Player drives playback.
      }}
      onCursorDragEnd={(time: number) => onScrub(Math.round(time * DEFAULT_FPS))}
      style={{ height: '100%' }}
    />
  );
}
