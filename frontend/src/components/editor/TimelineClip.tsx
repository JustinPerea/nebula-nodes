import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { snapToFrameGrid } from '../../lib/editor/frameAccurate';
import { type EditClip, clipSpeed } from '../../lib/editor/virtualPlayback';

interface Props {
  clip: EditClip;
  index: number;
  track: 'video' | 'audio';
  totalOutputDuration: number;
  sourceFps: number;
  editNodeId: string;
}

export function TimelineClip({ clip, totalOutputDuration, sourceFps, track, editNodeId }: Props) {
  const setSelectedClip = useUIStore((s) => s.setSelectedClip);
  const selectedClipId = useUIStore((s) => s.selectedClipId);
  const updateClip = useGraphStore((s) => s.updateEditNodeClip);

  // Output-time positioning: where the clip sits on the edited timeline.
  const leftPct = totalOutputDuration > 0 ? (clip.start / totalOutputDuration) * 100 : 0;
  const widthPct = totalOutputDuration > 0 ? (clip.duration / totalOutputDuration) * 100 : 0;

  const speed = clipSpeed(clip);
  const isEdited =
    Math.abs(speed - 1) > 0.0001 ||
    clip.volume !== 1.0 ||
    clip.mute ||
    clip.sourceIn > 0;
  const isSelected = selectedClipId === clip.id;

  function startDrag(edge: 'in' | 'out') {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const trackEl = (e.currentTarget as HTMLElement).closest('.editor-tl__track-body') as HTMLElement | null;
      if (!trackEl) return;
      const rect = trackEl.getBoundingClientRect();
      // Capture immutables at drag start: speed stays constant; source bounds
      // shift; duration recomputes from new source range / speed.
      const dragSpeed = speed;
      const origSourceIn = clip.sourceIn;
      const origSourceOut = clip.sourceOut;

      function onMove(ev: PointerEvent) {
        const x = (ev.clientX - rect.left) / rect.width;
        // Cursor is in OUTPUT time space (the track body's coordinate system).
        const cursorOutputTime = x * totalOutputDuration;
        // Translate cursor's output-time movement into source-time movement.
        // dragSpeed stays constant: source moves dragSpeed seconds per second of output.
        if (edge === 'in') {
          // IN handle: source-in shifts by (cursorOutputTime - clip.start) * speed.
          // Clamp so newSourceIn stays in [0, origSourceOut - 0.1 * speed]
          // (the latter preserves at least 0.1s of output duration).
          const deltaOutput = cursorOutputTime - clip.start;
          const newSourceInUnclamped = origSourceIn + deltaOutput * dragSpeed;
          const minSrcIn = 0;
          const maxSrcIn = origSourceOut - 0.1 * dragSpeed;
          const snappedSourceIn = snapToFrameGrid(
            Math.max(minSrcIn, Math.min(newSourceInUnclamped, maxSrcIn)),
            sourceFps,
          );
          const newDuration = (origSourceOut - snappedSourceIn) / dragSpeed;
          updateClip(editNodeId, clip.id, { sourceIn: snappedSourceIn, duration: newDuration });
        } else {
          // OUT handle: source-out shifts by (cursorOutputTime - (clip.start + clip.duration)) * speed.
          const clipEnd = clip.start + clip.duration;
          const deltaOutput = cursorOutputTime - clipEnd;
          const newSourceOutUnclamped = origSourceOut + deltaOutput * dragSpeed;
          const minSrcOut = origSourceIn + 0.1 * dragSpeed;
          // No hard upper bound here; the caller (Timeline) is responsible for
          // not letting source extend past sourceDuration. We clamp using the
          // source media's known duration from params (passed via the parent
          // chain implicitly through sourceFps; for now, just bound below).
          const snappedSourceOut = snapToFrameGrid(
            Math.max(minSrcOut, newSourceOutUnclamped),
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
