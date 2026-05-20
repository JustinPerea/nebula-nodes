import { useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import {
  type EditClip,
  outputTimeToSourceTime,
  totalOutputDuration as computeTotalOutputDuration,
} from '../../lib/editor/virtualPlayback';

interface Props {
  /** Total output duration in seconds — the playhead's full traverse range. */
  totalOutputDuration: number;
  clips: EditClip[];
}

export function TimelinePlayhead({ totalOutputDuration, clips }: Props) {
  const outputTime = useUIStore((s) => s.playheadOutputTime);
  const setOutputTime = useUIStore((s) => s.setPlayheadOutputTime);

  // Position the playhead in OUTPUT-time space. Wrapper provides correct
  // coordinate frame (track-body extent, not container).
  const leftPct = totalOutputDuration > 0 ? (outputTime / totalOutputDuration) * 100 : 0;

  // Debug hook: expose the SOURCE-time the playhead currently points at.
  // Useful for CLI/test inspection. Lives in useEffect to avoid the
  // react-hooks/immutability lint error from side-effects-during-render.
  useEffect(() => {
    const { sourceTime } = outputTimeToSourceTime(outputTime, clips);
    (window as Window & { __editorPlayheadSourceTime?: number }).__editorPlayheadSourceTime = sourceTime;
  });

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    const scrubArea = (e.currentTarget as HTMLElement).parentElement as HTMLElement | null;
    if (!scrubArea) return;
    const rect = scrubArea.getBoundingClientRect();
    const total = computeTotalOutputDuration(clips);
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
