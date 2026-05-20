import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { snapToFrameGrid } from '../../lib/editor/frameAccurate';
import { type EditClip } from '../../lib/editor/virtualPlayback';

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

  const leftPct = (clip.sourceIn / sourceDuration) * 100;
  const widthPct = ((clip.sourceOut - clip.sourceIn) / sourceDuration) * 100;
  const isEdited =
    clip.speed !== 1.0 ||
    clip.volume !== 1.0 ||
    clip.mute ||
    clip.sourceIn > 0 ||
    clip.sourceOut < sourceDuration;
  const isSelected = selectedClipId === clip.id;

  function startDrag(edge: 'in' | 'out') {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const trackEl = (e.currentTarget as HTMLElement).closest('.editor-tl__track-body') as HTMLElement | null;
      if (!trackEl) return;
      const rect = trackEl.getBoundingClientRect();

      function onMove(ev: PointerEvent) {
        const x = (ev.clientX - rect.left) / rect.width;
        const t = snapToFrameGrid(x * sourceDuration, sourceFps);
        if (edge === 'in') {
          const clamped = Math.max(0, Math.min(t, clip.sourceOut - 0.1));
          updateClip(editNodeId, clip.id, { sourceIn: clamped });
        } else {
          const clamped = Math.min(sourceDuration, Math.max(t, clip.sourceIn + 0.1));
          updateClip(editNodeId, clip.id, { sourceOut: clamped });
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
        {clip.speed !== 1.0 && <span className="editor-tl__clip-speed">{clip.speed}×</span>}
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
