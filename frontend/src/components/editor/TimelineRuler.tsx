import { useEffect, useState } from 'react';
import { formatSmpte } from '../../lib/editor/timecode';
import { getThumbnail } from '../../lib/editor/thumbnailStrip';

interface Props {
  sourceUrl: string;
  sourceDuration: number;
  sourceFps: number;
}

export function TimelineRuler({ sourceUrl, sourceDuration, sourceFps }: Props) {
  const stepCount = Math.max(1, Math.floor(sourceDuration / 2));
  const stepTimes = Array.from({ length: stepCount + 1 }, (_, i) => (sourceDuration * i) / stepCount);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const t of stepTimes) {
        try {
          const url = await getThumbnail({ sourceUrl, time: t, width: 80 });
          if (cancelled) return;
          setThumbs((prev) => ({ ...prev, [Number(t.toFixed(2))]: url }));
        } catch { /* placeholder will show */ }
      }
    })();
    return () => { cancelled = true; };
  }, [sourceUrl, sourceDuration]);

  return (
    <div className="editor-tl__ruler-wrap">
      <div className="editor-tl__ruler-thumbs">
        {stepTimes.map((t, i) => (
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
        {stepTimes.map((t, i) => (
          <span key={i} className="editor-tl__ruler-tick">{formatSmpte(t, sourceFps)}</span>
        ))}
      </div>
    </div>
  );
}
