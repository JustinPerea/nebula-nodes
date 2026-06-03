import { useEffect, useState } from 'react';
import { formatSmpte } from '../../lib/editor/timecode';
import { getThumbnail } from '../../lib/editor/thumbnailStrip';

interface Props {
  sourceUrl: string;
  /** Source media duration in seconds — the timeline's visual reference width. */
  sourceDuration: number;
  /** Output playback duration in seconds — used for tick labels (where the edit ends). */
  totalOutputDuration: number;
  /** Used for SMPTE display only. */
  sourceFps: number;
}

export function TimelineRuler({ sourceUrl, sourceDuration, totalOutputDuration, sourceFps }: Props) {
  // Tick every ~2 seconds of OUTPUT time, capped at 12 to keep the strip
  // from overflowing. Even spacing across the OUTPUT range.
  const stepCount = Math.max(1, Math.min(12, Math.floor(totalOutputDuration / 2)));
  const outputStepTimes = Array.from(
    { length: stepCount + 1 },
    (_, i) => (totalOutputDuration * i) / stepCount,
  );
  // Thumbnails sampled across source. Same step count for visual symmetry
  // with the ticks.
  const sourceStepTimes = Array.from(
    { length: stepCount + 1 },
    (_, i) => (sourceDuration * i) / stepCount,
  );
  const [thumbs, setThumbs] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const t of sourceStepTimes) {
        try {
          const url = await getThumbnail({ sourceUrl, time: t, width: 80 });
          if (cancelled) return;
          setThumbs((prev) => ({ ...prev, [Number(t.toFixed(2))]: url }));
        } catch { /* placeholder will show */ }
      }
    })();
    return () => { cancelled = true; };
    // sourceStepTimes is a fresh array each render, derived from sourceDuration
    // and stepCount (which tracks totalOutputDuration). Key on those primitives
    // so the strip re-syncs when an edit changes the sample set; getThumbnail is
    // cached, so a re-sync only fetches genuinely-new times.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl, sourceDuration, stepCount]);

  // Positions each ruler tick at its proportional position on the timeline.
  // Timeline width represents sourceDuration; ticks are output-time values,
  // so the last tick sits at totalOutputDuration / sourceDuration of the way
  // across (= 1 at speed=1, < 1 when sped up, > 1 when slowed — clipped by
  // overflow if so).
  function tickLeftPct(outputTime: number): number {
    if (sourceDuration <= 0) return 0;
    return Math.min(100, (outputTime / sourceDuration) * 100);
  }
  function thumbLeftPct(sourceTime: number): number {
    if (sourceDuration <= 0) return 0;
    return (sourceTime / sourceDuration) * 100;
  }

  return (
    <div className="editor-tl__ruler-wrap">
      <div className="editor-tl__ruler-thumbs">
        {sourceStepTimes.map((t, i) => (
          <div
            key={i}
            className="editor-tl__ruler-thumb"
            style={{ left: `${thumbLeftPct(t)}%` }}
          >
            {thumbs[Number(t.toFixed(2))] ? (
              <img src={thumbs[Number(t.toFixed(2))]} alt="" />
            ) : (
              <div className="editor-tl__ruler-thumb-placeholder" />
            )}
          </div>
        ))}
      </div>
      <div className="editor-tl__ruler">
        {outputStepTimes.map((t, i) => (
          <span
            key={i}
            className="editor-tl__ruler-tick"
            style={{ left: `${tickLeftPct(t)}%` }}
          >
            {formatSmpte(t, sourceFps)}
          </span>
        ))}
      </div>
    </div>
  );
}
