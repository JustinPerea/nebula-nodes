import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Node } from '@xyflow/react';
import { ArrowLeft } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { snapToFrameGrid } from '../../lib/editor/frameAccurate';
import {
  type EditClip,
  outputTimeToSourceTime,
  totalOutputDuration,
  clipSpeed,
} from '../../lib/editor/virtualPlayback';
import { formatSmpte } from '../../lib/editor/timecode';
import { floatingBottomLimit } from '../../lib/bottomBar';
import type { NodeData } from '../../types';

const EMPTY_CLIPS: EditClip[] = [];
/** How far the rendered picture stops above the preview's foot (the notice band's reach), in px. */
const NOTICE_BAND_INSET_VAR = '--notice-band-inset';

interface Props {
  sourceUrl: string;
  editNode: Node<NodeData>;
}

export function VideoPreview({ sourceUrl, editNode }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const outputTime = useUIStore((s) => s.playheadOutputTime);
  const setOutputTime = useUIStore((s) => s.setPlayheadOutputTime);
  const renderedPreviewUrl = useUIStore((s) => s.renderedPreviewUrl);
  const isPlaying = useUIStore((s) => s.isPlaying);
  const togglePlaying = useUIStore((s) => s.togglePlaying);
  const [sourceError, setSourceError] = useState(false);

  const params = editNode.data.params;
  const clips = Array.isArray(params.clips) ? (params.clips as EditClip[]) : EMPTY_CLIPS;
  const fps = typeof params.sourceFps === 'number' ? params.sourceFps : 30;
  const totalDur = totalOutputDuration(clips);
  const showingRendered = renderedPreviewUrl != null;
  const videoSrc = renderedPreviewUrl ?? sourceUrl;
  // The preview's bottom edge carries the app's notices (the transport row
  // publishes its top edge: GM - Design, round 4b, "so notices sit over the
  // preview's bottom edge"). The rendered preview has native controls on its
  // video's bottom edge, so while it shows, the picture stops above the
  // notice region's reserved band, the way floating panels do (GM, round 2:
  // "Floating panels stop above a reserved notice band, whether or not a
  // notice is showing"): a notice never covers its scrubber or time. The
  // source preview has no controls there and keeps its full height. The
  // preview writes the inset as `--notice-band-inset`, which only the video
  // reads (EditorView.css), so the preview keeps its size and the transport
  // and timeline under it never move.
  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!showingRendered || !preview) return;
    const measure = () => {
      const box = preview.getBoundingClientRect();
      const lowest = floatingBottomLimit(0, window.innerHeight, { left: box.left, right: box.right });
      preview.style.setProperty(NOTICE_BAND_INSET_VAR, `${Math.max(0, Math.round(box.bottom - lowest))}px`);
    };
    measure();
    // The preview's box changes when the transport wraps or the window resizes.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(preview);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      preview.style.removeProperty(NOTICE_BAND_INSET_VAR);
    };
  }, [showingRendered, sourceError]);

  // Sync video element to outputTime + active clip's speed/volume/mute.
  // Skipped when showing the rendered preview — that file is the final
  // edit already, no virtual-playback math needed.
  useEffect(() => {
    if (showingRendered) return;
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
  }, [outputTime, clips, fps, showingRendered]);

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

  // Space to play/pause — kept on VideoPreview rather than EditorView so the
  // shortcut only fires when the editor surface is mounted.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.key !== ' ' || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target;
      // Native activation/typing owns Space on controls, including a child
      // icon inside the shared Back button and rendered video controls.
      if (target instanceof Element && target.closest(
        'button, input, textarea, select, a[href], summary, [contenteditable]:not([contenteditable="false"]), '
        + '[role="button"], [role="textbox"], [role="combobox"], [role="slider"], video[controls], audio[controls]',
      )) return;
      e.preventDefault();
      togglePlaying();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlaying]);

  if (sourceError) {
    return (
      <div className="editor-preview editor-preview--error">
        <span>Source unavailable. Try re-running upstream.</span>
        <button type="button" onClick={() => useUIStore.getState().exitEditor()}>
          <ArrowLeft className="editor-preview__button-icon" aria-hidden="true" focusable="false" />
          <span>Back to Canvas</span>
        </button>
      </div>
    );
  }

  return (
    <div ref={previewRef} className="editor-preview">
      <video
        ref={videoRef}
        src={videoSrc}
        playsInline
        controls={showingRendered}
        className="editor-preview__video"
        onError={() => setSourceError(true)}
      />
      <div className="editor-preview__hud">
        <span>{formatSmpte(outputTime, fps)} / {formatSmpte(totalDur, fps)}</span>
        {showingRendered ? <span className="editor-preview__hud-tag">Rendered</span> : null}
      </div>
    </div>
  );
}
