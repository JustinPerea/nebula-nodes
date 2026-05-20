import { useEffect, useState } from 'react';
import { formatSmpte } from '../../lib/editor/timecode';
import { getThumbnail } from '../../lib/editor/thumbnailStrip';

interface Props {
  sourceUrl: string;
  /** Total output duration in seconds — the timeline's full visible range. */
  totalOutputDuration: number;
  /** Used for SMPTE display only. */
  sourceFps: number;
  /** Used to compute thumbnail source times (proportionally mapped from output). */
  sourceDuration: number;
}

export function TimelineRuler({ sourceUrl, totalOutputDuration, sourceFps, sourceDuration }: Props) {
  // Tick every ~2 seconds of OUTPUT time, capped to keep the strip from
  // overflowing on long durations. Phase D code review flagged uncapped
  // step counts; this preserves that limit while moving to output time.
  const stepCount = Math.max(1, Math.min(12, Math.floor(totalOutputDuration / 2)));
  const outputStepTimes = Array.from(
    { length: stepCount + 1 },
    (_, i) => (totalOutputDuration * i) / stepCount,
  );
  // Thumbnails are sampled from source time. We pick proportional source
  // times so the strip shows a roughly representative sweep of the media —
  // accurate-to-output-time-position would require integrating across
  // speed-changed clips, which is Phase 2 work.
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl, sourceDuration]);

  return (
    <div className="editor-tl__ruler-wrap">
      <div className="editor-tl__ruler-thumbs">
        {sourceStepTimes.map((t, i) => (
          <div key={i} className="editor-tl__ruler-thumb">
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
          <span key={i} className="editor-tl__ruler-tick">{formatSmpte(t, sourceFps)}</span>
        ))}
      </div>
    </div>
  );
}
