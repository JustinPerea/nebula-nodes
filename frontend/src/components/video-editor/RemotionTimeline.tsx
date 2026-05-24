import { useMemo } from 'react';
import { Timeline as XzdarcyTimeline } from '@xzdarcy/react-timeline-editor';
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';
import type {
  TimelineRow,
  TimelineEffect,
  Emitter,
  EventTypes,
} from '@xzdarcy/timeline-engine';
import type { VideoGraphManifest, TrackItem } from '../../types/video';
import { DEFAULT_FPS } from '../../types/video';
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';

/** Local structural typing for the @xzdarcy timeline imperative ref.
 *  We don't import from the package's deep dist/ path because it's an internal
 *  build artifact — restructuring on a patch release would silently break us.
 *  All fields are derived from the package's public surface types only
 *  (Emitter/EventTypes come from @xzdarcy/timeline-engine public index). */
export interface TimelineState {
  target: HTMLElement | null;
  listener: Emitter<EventTypes>;
  isPlaying: boolean;
  isPaused: boolean;
  setTime: (time: number) => void;
  getTime: () => number;
  setPlayRate: (rate: number) => void;
  getPlayRate: () => number;
  reRender: () => void;
  play: (param: { toTime?: number; autoEnd?: boolean; runActionIds?: string[] }) => boolean;
  pause: () => void;
  setScrollLeft: (val: number) => void;
  setScrollTop: (val: number) => void;
}

interface RemotionTimelineProps {
  remotionNodeId: string;
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
      },
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
  remotionNodeId,
  manifest,
  onScrub,
  timelineState,
}: RemotionTimelineProps) {
  const editorData = useMemo(() => manifestToEditorData(manifest), [manifest]);

  const updateTrackItemTime = useGraphStore((s) => s.updateTrackItemTime);
  const setSelectedTrackItem = useUIStore((s) => s.setSelectedTrackItem);
  const toggleSelectedTrackItem = useUIStore((s) => s.toggleSelectedTrackItem);
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);
  const selectedTrackItemIds = useUIStore((s) => s.selectedTrackItemIds);

  // data-selected-id is a hook for T10 CSS styling — gives the selected track
  // item's id to the DOM so the row highlight rule can target it.
  return (
    <div
      style={{ height: '100%' }}
      data-selected-id={selectedTrackItemId ?? ''}
      data-selected-ids={selectedTrackItemIds.join(' ')}
    >
      <XzdarcyTimeline
        ref={timelineState}
        editorData={editorData}
        effects={EFFECTS}
        autoScroll
        onClickAction={(e, { action }) => {
          const event = e as unknown as MouseEvent;
          if (event.shiftKey || event.metaKey || event.ctrlKey) {
            toggleSelectedTrackItem(action.id);
            return;
          }
          setSelectedTrackItem(action.id);
        }}
        onActionMoveEnd={({ action, start }) => {
          updateTrackItemTime(remotionNodeId, action.id, {
            startFrame: Math.round(start * DEFAULT_FPS),
          });
        }}
        onActionResizeEnd={({ action, start, end }) => {
          updateTrackItemTime(remotionNodeId, action.id, {
            startFrame: Math.round(start * DEFAULT_FPS),
            durationInFrames: Math.round((end - start) * DEFAULT_FPS),
          });
        }}
        onCursorDragEnd={(time: number) => onScrub(Math.round(time * DEFAULT_FPS))}
        style={{ height: '100%' }}
      />
    </div>
  );
}
