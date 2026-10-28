import { useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { refuseCanvasEdit, useCanvasLock } from '../../lib/canvasLock';
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
  // The timeline writes a drop into the rows it was given (the action's
  // start and end, in place) before it calls onActionMoveEnd, and each block
  // keeps where it was dragged in its own state. A drop refused while locked
  // would stay drawn where it was let go, though nothing was saved, until the
  // manifest next changed. `redraw` draws the timeline again from the
  // manifest (fresh rows, a new mount), so the block goes back to where it
  // is (fix round 5 of PR #200, review 5 N-5; live: fresh rows alone left the
  // block where it was dropped).
  const [redraw, setRedraw] = useState(0);
  const editorData = useMemo(() => { void redraw; return manifestToEditorData(manifest); }, [manifest, redraw]);

  const updateTrackItemTime = useGraphStore((s) => s.updateTrackItemTime);
  // Round 23 (review 22, L-3): moving and resizing a layer edit the canvas;
  // while following or offline the timeline doesn't drag (selecting and
  // scrubbing still work).
  const lock = useCanvasLock();
  const setSelectedTrackItem = useUIStore((s) => s.setSelectedTrackItem);
  const toggleSelectedTrackItem = useUIStore((s) => s.toggleSelectedTrackItem);
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);
  const selectedTrackItemIds = useUIStore((s) => s.selectedTrackItemIds);

  // A redraw is a new mount, which starts scrolled to 0: it keeps where the
  // person had scrolled (fix round 6 of PR #200, review 6 N-5). The old
  // timeline's scroll is taken as it goes (this cleanup runs before the new
  // one mounts); the new one reports 0 as it mounts, which is ignored, and
  // is then scrolled back. Live: restoring from the last onScroll alone
  // found 0, the new mount's own report.
  const drawKey = `${redraw}:${lock.locked ? 'locked' : 'open'}`;
  const scrolledLeft = useRef(0);
  const restoring = useRef<number | null>(null);
  useLayoutEffect(() => () => { restoring.current = scrolledLeft.current; }, [drawKey]);
  useLayoutEffect(() => {
    const left = restoring.current;
    if (left === null) return;
    restoring.current = null;
    if (left > 0) timelineState.current?.setScrollLeft(left);
  }, [drawKey, timelineState]);

  // data-selected-id is a hook for T10 CSS styling — gives the selected track
  // item's id to the DOM so the row highlight rule can target it.
  return (
    <div
      style={{ height: '100%' }}
      data-selected-id={selectedTrackItemId ?? ''}
      data-selected-ids={selectedTrackItemIds.join(' ')}
    >
      <XzdarcyTimeline
        // A drag under way when the lock starts: the timeline turns dragging
        // off and drops the gesture without reporting its end (live: the block
        // stayed 96 px from where it is), so the lock starting or ending draws
        // it again too.
        key={drawKey}
        onScroll={({ scrollLeft }) => { if (restoring.current === null) scrolledLeft.current = scrollLeft; }}
        ref={timelineState}
        editorData={editorData}
        effects={EFFECTS}
        autoScroll
        disableDrag={lock.locked}
        onClickAction={(e, { action }) => {
          const event = e as unknown as MouseEvent;
          if (event.shiftKey || event.metaKey || event.ctrlKey) {
            toggleSelectedTrackItem(action.id);
            return;
          }
          setSelectedTrackItem(action.id);
        }}
        // `disableDrag` stops the drag; a drag already under way when the
        // lock starts ends without writing (fix round 4 of PR #200, review 4
        // LOW-4).
        onActionMoveEnd={({ action, start }) => {
          if (refuseCanvasEdit()) { setRedraw((n) => n + 1); return; }
          updateTrackItemTime(remotionNodeId, action.id, {
            startFrame: Math.round(start * DEFAULT_FPS),
          });
        }}
        onActionResizeEnd={({ action, start, end }) => {
          if (refuseCanvasEdit()) { setRedraw((n) => n + 1); return; }
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
