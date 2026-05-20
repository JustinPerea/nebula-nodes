import { useEffect, useRef, useState } from 'react';
import type { Node } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { snapToFrameGrid } from '../../lib/editor/frameAccurate';
import {
  type EditClip,
  outputTimeToSourceTime,
  totalOutputDuration,
  clipSpeed,
} from '../../lib/editor/virtualPlayback';
import { formatSmpte } from '../../lib/editor/timecode';

interface Props {
  sourceUrl: string;
  editNode: Node;
}

export function VideoPreview({ sourceUrl, editNode }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const outputTime = useUIStore((s) => s.playheadOutputTime);
  const setOutputTime = useUIStore((s) => s.setPlayheadOutputTime);
  const [isPlaying, setIsPlaying] = useState(false);
  const [sourceError, setSourceError] = useState(false);

  const params = (editNode.data as any).params ?? {};
  const clips: EditClip[] = params.clips ?? [];
  const fps: number = params.sourceFps ?? 30;
  const totalDur = totalOutputDuration(clips);

  // Sync video element to outputTime + active clip's speed/volume/mute
  useEffect(() => {
    const video = videoRef.current;
    if (!video || clips.length === 0) return;
    const { clipIndex, sourceTime } = outputTimeToSourceTime(outputTime, clips);
    if (clipIndex < 0) return;
    const clip = clips[clipIndex];
    const snapped = snapToFrameGrid(sourceTime, fps);
    if (Math.abs(video.currentTime - snapped) > 0.05) {
      video.currentTime = snapped;
    }
    video.playbackRate = clipSpeed(clip);
    video.muted = clip.mute;
    video.volume = clip.volume;
  }, [outputTime, clips, fps]);

  // Virtual playback loop
  useEffect(() => {
    if (!isPlaying) return;
    let rafId: number;
    let cancelled = false;
    let lastTick = performance.now();

    function tick() {
      if (cancelled) return;
      const now = performance.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;
      const next = outputTime + dt;
      setOutputTime(next >= totalDur ? 0 : next);
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
    return () => { cancelled = true; cancelAnimationFrame(rafId); };
  }, [isPlaying, totalDur, outputTime, setOutputTime]);

  // Space to play/pause
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === ' ' && !e.repeat && (e.target as HTMLElement).tagName !== 'INPUT') {
        e.preventDefault();
        setIsPlaying((p) => !p);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (sourceError) {
    return (
      <div className="editor-preview editor-preview--error">
        Source unavailable — try re-running upstream.
        <button onClick={() => useUIStore.getState().exitEditor()}>Back to Canvas</button>
      </div>
    );
  }

  return (
    <div className="editor-preview">
      <video
        ref={videoRef}
        src={sourceUrl}
        playsInline
        className="editor-preview__video"
        onError={() => setSourceError(true)}
      />
      <div className="editor-preview__hud">
        <span>{formatSmpte(outputTime, fps)} / {formatSmpte(totalDur, fps)}</span>
      </div>
    </div>
  );
}
