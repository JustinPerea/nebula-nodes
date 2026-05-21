import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { snapToFrameGrid } from '../../lib/editor/frameAccurate';
import { type EditClip, clipSpeed, isClipEdited } from '../../lib/editor/virtualPlayback';

interface Props {
  clip: EditClip;
  index: number;
  track: 'video' | 'audio';
  sourceDuration: number;
  sourceFps: number;
  editNodeId: string;
}

export function TimelineClip({ clip, sourceDuration, sourceFps, track, editNodeId }: Props) {
  const setSelectedClip = useUIStore((s) => s.setSelectedClip);
  const selectedClipId = useUIStore((s) => s.selectedClipId);
  const updateClip = useGraphStore((s) => s.updateEditNodeClip);

  // Visual layout against sourceDuration (the timeline's reference frame).
  // Speed-up shrinks the bar; slow-down would make it overflow (Phase 1
  // accepts this — overflow-x: hidden on the track body clips it visually).
  const leftPct = sourceDuration > 0 ? (clip.start / sourceDuration) * 100 : 0;
  const widthPct = sourceDuration > 0 ? (clip.duration / sourceDuration) * 100 : 0;

  const speed = clipSpeed(clip);
  const isEdited = isClipEdited(clip, sourceDuration);
  const isSelected = selectedClipId === clip.id;

  function startDrag(edge: 'in' | 'out') {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const trackEl = (e.currentTarget as HTMLElement).closest('.editor-tl__track-body') as HTMLElement | null;
      if (!trackEl) return;
      const rect = trackEl.getBoundingClientRect();
      const dragSpeed = speed;
      const origSourceIn = clip.sourceIn;
      const origSourceOut = clip.sourceOut;

      function onMove(ev: PointerEvent) {
        const x = (ev.clientX - rect.left) / rect.width;
        // Cursor position in TIMELINE-reference space (sourceDuration is
        // the reference frame). Multiply by dragSpeed to get source-time
        // delta from the clip edge.
        const cursorTimelineTime = x * sourceDuration;
        if (edge === 'in') {
          // IN handle: source-in shifts by (cursorTimelineTime - clip.start) * speed.
          const deltaTimeline = cursorTimelineTime - clip.start;
          const newSourceInUnclamped = origSourceIn + deltaTimeline * dragSpeed;
          const minSrcIn = 0;
          const maxSrcIn = origSourceOut - 0.1 * dragSpeed;
          const snappedSourceIn = snapToFrameGrid(
            Math.max(minSrcIn, Math.min(newSourceInUnclamped, maxSrcIn)),
            sourceFps,
          );
          const newDuration = (origSourceOut - snappedSourceIn) / dragSpeed;
          updateClip(editNodeId, clip.id, { sourceIn: snappedSourceIn, duration: newDuration });
        } else {
          // OUT handle: source-out shifts by (cursorTimelineTime - (clip.start + clip.duration)) * speed.
          const clipEnd = clip.start + clip.duration;
          const deltaTimeline = cursorTimelineTime - clipEnd;
          const newSourceOutUnclamped = origSourceOut + deltaTimeline * dragSpeed;
          const minSrcOut = origSourceIn + 0.1 * dragSpeed;
          const maxSrcOut = sourceDuration;
          const snappedSourceOut = snapToFrameGrid(
            Math.max(minSrcOut, Math.min(newSourceOutUnclamped, maxSrcOut)),
            sourceFps,
          );
          const newDuration = (snappedSourceOut - origSourceIn) / dragSpeed;
          updateClip(editNodeId, clip.id, { sourceOut: snappedSourceOut, duration: newDuration });
        }
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
  }

  return (
    <div
      className={`editor-tl__clip ${isEdited ? 'editor-tl__clip--edited' : ''} ${isSelected ? 'editor-tl__clip--selected' : ''} editor-tl__clip--${track}`}
      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
      onClick={(e) => { e.stopPropagation(); setSelectedClip(clip.id); }}
    >
      {track === 'video' && (
        <div className="editor-tl__clip-handle editor-tl__clip-handle--in" onPointerDown={startDrag('in')} />
      )}
      <span className="editor-tl__clip-label">
        clip {clip.id}
        {Math.abs(speed - 1) > 0.0001 && (
          <span className="editor-tl__clip-speed">{speed.toFixed(2)}×</span>
        )}
      </span>
      {track === 'audio' && clip.volume !== 1.0 && (
        <span className="editor-tl__clip-vol">vol {Math.round(clip.volume * 100)}%</span>
      )}
      {track === 'video' && (
        <div className="editor-tl__clip-handle editor-tl__clip-handle--out" onPointerDown={startDrag('out')} />
      )}
    </div>
  );
}
