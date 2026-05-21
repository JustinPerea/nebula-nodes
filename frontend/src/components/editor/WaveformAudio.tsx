import { useEffect, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';

interface Props {
  sourceUrl: string;
}

export function WaveformAudio({ sourceUrl }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: sourceUrl,
      barWidth: 1,
      barGap: 1,
      barHeight: 0.8,
      barRadius: 0,
      waveColor: 'rgba(255, 255, 255, 0.40)',
      progressColor: 'rgba(255, 90, 31, 0.60)',
      cursorColor: 'transparent',
      height: 18,
      interact: false,
      normalize: true,
    });
    return () => ws.destroy();
  }, [sourceUrl]);

  return <div ref={containerRef} className="editor-tl__waveform" />;
}
