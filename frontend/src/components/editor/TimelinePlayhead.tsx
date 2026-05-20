import { useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import {
  type EditClip,
  outputTimeToSourceTime,
} from '../../lib/editor/virtualPlayback';

interface Props {
  /** Source media duration in seconds — the timeline's visual reference width. */
  sourceDuration: number;
  /** Output playback duration — scrub clamp upper bound (can't scrub past edit end). */
  totalOutputDuration: number;
  clips: EditClip[];
}

export function TimelinePlayhead({ sourceDuration, totalOutputDuration, clips }: Props) {
  const outputTime = useUIStore((s) => s.playheadOutputTime);
  const setOutputTime = useUIStore((s) => s.setPlayheadOutputTime);

  // Position the playhead in TIMELINE-reference space. Timeline width
  // represents sourceDuration; playhead reaches the clip's right edge when
  // outputTime hits totalOutputDuration.
  const leftPct = sourceDuration > 0 ? (outputTime / sourceDuration) * 100 : 0;

  // Debug hook: expose source-time at the playhead position.
  useEffect(() => {
    const { sourceTime } = outputTimeToSourceTime(outputTime, clips);
    (window as Window & { __editorPlayheadSourceTime?: number }).__editorPlayheadSourceTime = sourceTime;
  });

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    const scrubArea = (e.currentTarget as HTMLElement).parentElement as HTMLElement | null;
    if (!scrubArea) return;
    const rect = scrubArea.getBoundingClientRect();
    function onMove(ev: PointerEvent) {
      const x = (ev.clientX - rect.left) / rect.width;
      // Cursor position in TIMELINE-reference space maps to a source-time
      // equivalent; clamp into the valid output-time range [0, totalOutputDuration].
      const cursorTimelineTime = x * sourceDuration;
      setOutputTime(Math.max(0, Math.min(totalOutputDuration, cursorTimelineTime)));
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
