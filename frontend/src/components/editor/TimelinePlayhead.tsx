import { useUIStore } from '../../store/uiStore';
import {
  type EditClip,
  outputTimeToSourceTime,
  totalOutputDuration,
} from '../../lib/editor/virtualPlayback';

interface Props {
  sourceDuration: number;
  clips: EditClip[];
}

export function TimelinePlayhead({ sourceDuration, clips }: Props) {
  const outputTime = useUIStore((s) => s.playheadOutputTime);
  const setOutputTime = useUIStore((s) => s.setPlayheadOutputTime);

  const { sourceTime } = outputTimeToSourceTime(outputTime, clips);
  const leftPct = sourceDuration > 0 ? (sourceTime / sourceDuration) * 100 : 0;

  if (typeof window !== 'undefined') {
    (window as any).__editorPlayheadSourceTime = sourceTime;
  }

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    const tracksEl = (e.currentTarget as HTMLElement).parentElement?.querySelector(
      '.editor-tl__tracks',
    ) as HTMLElement | null;
    if (!tracksEl) return;
    const rect = tracksEl.getBoundingClientRect();
    const total = totalOutputDuration(clips);
    function onMove(ev: PointerEvent) {
      const x = (ev.clientX - rect.left) / rect.width;
      setOutputTime(Math.max(0, Math.min(total, x * total)));
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <div
      className="editor-tl__playhead"
      style={{ left: `${leftPct}%`, cursor: 'ew-resize', pointerEvents: 'auto' }}
      onPointerDown={onPointerDown}
    />
  );
}
