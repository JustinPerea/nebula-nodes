import { useRef, useState } from 'react';
import type { Node } from '@xyflow/react';
import {
  Gauge,
  Download,
  Pause,
  Play,
  RotateCw,
  Scissors,
  SkipBack,
  SkipForward,
  Split,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { renderPreview } from '../../lib/editor/api';
import { backendAssetUrlSync } from '../../lib/backend';
import {
  startVideoExport,
  type VideoExportFormat,
  type VideoExportQuality,
  type VideoExportResolution,
} from '../../lib/renderJobs';
import { useRenderJob } from '../../hooks/useRenderJob';
import { type EditClip, totalOutputDuration, clipSpeed, clampSpeedToFloor } from '../../lib/editor/virtualPlayback';
import { formatSmpte } from '../../lib/editor/timecode';
import type { NodeData } from '../../types';

const EMPTY_CLIPS: EditClip[] = [];

interface Props {
  editNode: Node<NodeData>;
  sourceUrl: string;
}

export function EditorTransport({ editNode, sourceUrl }: Props) {
  const [isRendering, setIsRendering] = useState(false);
  const [hasRendered, setHasRendered] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<VideoExportFormat>('mp4');
  const [exportResolution, setExportResolution] = useState<VideoExportResolution>('source');
  const [exportQuality, setExportQuality] = useState<VideoExportQuality>('balanced');
  const renderJob = useRenderJob();
  const selectedClipId = useUIStore((s) => s.selectedClipId);
  const timelineZoom = useUIStore((s) => s.timelineZoom);
  const isPlaying = useUIStore((s) => s.isPlaying);
  const togglePlaying = useUIStore((s) => s.togglePlaying);
  const setSelectedClip = useUIStore((s) => s.setSelectedClip);
  const playheadOutputTime = useUIStore((s) => s.playheadOutputTime);
  const setPlayheadOutputTime = useUIStore((s) => s.setPlayheadOutputTime);
  const setRenderedPreviewUrl = useUIStore((s) => s.setRenderedPreviewUrl);
  const updateClip = useGraphStore((s) => s.updateEditNodeClip);
  const cutAtSource = useGraphStore((s) => s.cutEditNodeAtSource);
  const speedSliderRef = useRef<HTMLInputElement>(null);
  const volSliderRef = useRef<HTMLInputElement>(null);

  const params = editNode.data.params;
  const clips = Array.isArray(params.clips) ? (params.clips as EditClip[]) : EMPTY_CLIPS;
  const fps = typeof params.sourceFps === 'number' ? params.sourceFps : 30;
  const totalDur = totalOutputDuration(clips);
  const selectedClip = clips.find((c) => c.id === selectedClipId);

  // Edit points = clip start times. Used by SkipBack / SkipForward to
  // jump the playhead to the previous / next cut boundary.
  function jumpToPrevEditPoint() {
    if (clips.length === 0) return;
    const points = clips.map((c) => c.start);
    const epsilon = 1 / fps;
    const before = points.filter((p) => p < playheadOutputTime - epsilon);
    setPlayheadOutputTime(before.length > 0 ? before[before.length - 1] : 0);
  }
  function jumpToNextEditPoint() {
    if (clips.length === 0) return;
    const points = clips.map((c) => c.start);
    const epsilon = 1 / fps;
    const after = points.find((p) => p > playheadOutputTime + epsilon);
    setPlayheadOutputTime(after ?? totalDur);
  }

  // Ensure a clip is selected before opening the inspector. Used by the
  // Trim / Speed / Cut / Vol toolbar buttons so a fresh user who hasn't
  // clicked a clip yet still gets the inspector to appear.
  function ensureClipSelected(): string | null {
    if (selectedClipId) return selectedClipId;
    if (clips.length === 0) return null;
    const first = clips[0].id;
    setSelectedClip(first);
    return first;
  }

  function handleTrim() {
    ensureClipSelected();
  }
  function handleSpeed() {
    ensureClipSelected();
    // Defer focus until after the inspector mounts (selectedClip render).
    requestAnimationFrame(() => speedSliderRef.current?.focus());
  }
  function handleCut() {
    if (clips.length === 0) return;
    // Read the live source-time the playhead exposes — matches the B key path.
    const srcT = (window as Window & { __editorPlayheadSourceTime?: number }).__editorPlayheadSourceTime ?? 0;
    cutAtSource(editNode.id, srcT);
  }
  function handleVol() {
    ensureClipSelected();
    requestAnimationFrame(() => volSliderRef.current?.focus());
  }

  async function handleRender() {
    setIsRendering(true);
    try {
      const previewUrl = await renderPreview({ sourceUrl, clips });
      setRenderedPreviewUrl(previewUrl);
      setHasRendered(true);
    } catch (err) {
      console.error(err);
    } finally {
      setIsRendering(false);
    }
  }

  function handleFinalExport() {
    void renderJob.begin(() => startVideoExport({
      sourceUrl,
      clips,
      format: exportFormat,
      resolution: exportResolution,
      quality: exportQuality,
    }));
  }

  return (
    <div className="editor-transport">
      <div className="editor-transport__group">
        <button
          className="editor-transport__btn editor-transport__btn--primary"
          type="button"
          onClick={togglePlaying}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          title="Space"
        >
          {isPlaying ? (
            <Pause className="editor-transport__icon" aria-hidden="true" focusable="false" />
          ) : (
            <Play className="editor-transport__icon" aria-hidden="true" focusable="false" />
          )}
          <span>{isPlaying ? 'Pause' : 'Play'}</span>
        </button>
        <button
          className="editor-transport__btn editor-transport__btn--icon"
          type="button"
          aria-label="Previous edit point"
          onClick={jumpToPrevEditPoint}
          disabled={clips.length === 0}
        >
          <SkipBack className="editor-transport__icon" aria-hidden="true" focusable="false" />
        </button>
        <button
          className="editor-transport__btn editor-transport__btn--icon"
          type="button"
          aria-label="Next edit point"
          onClick={jumpToNextEditPoint}
          disabled={clips.length === 0}
        >
          <SkipForward className="editor-transport__icon" aria-hidden="true" focusable="false" />
        </button>
      </div>
      <span className="editor-transport__divider" />
      <div className="editor-transport__group">
        <button className="editor-transport__tool" type="button" onClick={handleTrim} disabled={clips.length === 0} title="Drag the clip edges to trim">
          <Scissors className="editor-transport__icon" aria-hidden="true" focusable="false" />
          <span>Trim</span>
        </button>
        <button className="editor-transport__tool" type="button" onClick={handleSpeed} disabled={clips.length === 0} title="Adjust playback speed">
          <Gauge className="editor-transport__icon" aria-hidden="true" focusable="false" />
          <span>Speed</span>
        </button>
        <button className="editor-transport__tool" type="button" onClick={handleCut} disabled={clips.length === 0} title="Cut at playhead (B)">
          <Split className="editor-transport__icon" aria-hidden="true" focusable="false" />
          <span>Cut</span>
        </button>
        <button className="editor-transport__tool" type="button" onClick={handleVol} disabled={clips.length === 0} title="Adjust volume / mute">
          <Volume2 className="editor-transport__icon" aria-hidden="true" focusable="false" />
          <span>Vol</span>
        </button>
      </div>

      {selectedClip && (
        <div className="editor-transport__inspector">
          <label className="editor-transport__label">Speed</label>
          <input ref={speedSliderRef} className="editor-transport__range" type="range" min={0.25} max={4} step={0.05}
            value={clipSpeed(selectedClip)}
            onChange={(e) => {
              const newSpeed = parseFloat(e.target.value);
              if (newSpeed <= 0) return;
              // Clamp to MIN_OUTPUT_DURATION floor so a fast speed on a short
              // source clip can't produce sub-floor output. clampSpeedToFloor
              // gracefully holds speed at 1× when the source range itself is
              // shorter than the floor (extreme-short generator output).
              const sourceRange = selectedClip.sourceOut - selectedClip.sourceIn;
              const { duration } = clampSpeedToFloor(newSpeed, sourceRange);
              updateClip(editNode.id, selectedClip.id, { duration });
            }} />
          <span className="editor-transport__value">{clipSpeed(selectedClip).toFixed(2)}×</span>
          <button className="editor-transport__preset" type="button" onClick={() => {
            const sourceRange = selectedClip.sourceOut - selectedClip.sourceIn;
            const { duration } = clampSpeedToFloor(0.5, sourceRange);
            updateClip(editNode.id, selectedClip.id, { duration });
          }}>0.5×</button>
          <button className="editor-transport__preset" type="button" onClick={() => {
            const sourceRange = selectedClip.sourceOut - selectedClip.sourceIn;
            const { duration } = clampSpeedToFloor(1, sourceRange);
            updateClip(editNode.id, selectedClip.id, { duration });
          }}>1×</button>
          <button className="editor-transport__preset" type="button" onClick={() => {
            const sourceRange = selectedClip.sourceOut - selectedClip.sourceIn;
            const { duration } = clampSpeedToFloor(2, sourceRange);
            updateClip(editNode.id, selectedClip.id, { duration });
          }}>2×</button>

          <label className="editor-transport__label">Vol</label>
          <input ref={volSliderRef} className="editor-transport__range" type="range" min={0} max={1} step={0.05}
            value={selectedClip.mute ? 0 : selectedClip.volume}
            disabled={selectedClip.mute}
            onChange={(e) => updateClip(editNode.id, selectedClip.id, { volume: parseFloat(e.target.value) })} />
          <span className="editor-transport__value">
            {Math.round((selectedClip.mute ? 0 : selectedClip.volume) * 100)}%
          </span>
          <button
            type="button"
            className="editor-transport__btn editor-transport__btn--icon"
            onClick={() => updateClip(editNode.id, selectedClip.id, { mute: !selectedClip.mute })}
            aria-pressed={selectedClip.mute}
            aria-label={selectedClip.mute ? 'Unmute clip' : 'Mute clip'}
          >
            {selectedClip.mute ? (
              <VolumeX className="editor-transport__icon" aria-hidden="true" focusable="false" />
            ) : (
              <Volume2 className="editor-transport__icon" aria-hidden="true" focusable="false" />
            )}
          </button>
        </div>
      )}

      <span className="editor-transport__summary">
        {clips.length} clip{clips.length === 1 ? '' : 's'} · {formatSmpte(totalDur, fps)}
      </span>
      <div className="editor-transport__zoom">
        <button
          type="button"
          className="editor-transport__btn"
          onClick={() => useUIStore.getState().zoomTimelineOut()}
          title="Zoom out (⌘-)"
        >
          −
        </button>
        <button
          type="button"
          className="editor-transport__btn"
          onClick={() => useUIStore.getState().resetTimelineZoom()}
          title="Reset zoom (⌘0)"
        >
          {timelineZoom.toFixed(1)}×
        </button>
        <button
          type="button"
          className="editor-transport__btn"
          onClick={() => useUIStore.getState().zoomTimelineIn()}
          title="Zoom in (⌘=)"
        >
          +
        </button>
      </div>
      <button
        type="button"
        className="editor-transport__btn editor-transport__btn--render"
        onClick={handleRender}
        disabled={isRendering || clips.length === 0}
      >
        <RotateCw className="editor-transport__icon" aria-hidden="true" focusable="false" />
        <span>{isRendering ? 'Rendering...' : hasRendered ? 'Re-render' : 'Render Preview'}</span>
      </button>
      <div className="final-export">
        <button
          type="button"
          className="editor-transport__btn editor-transport__btn--export"
          onClick={() => setExportOpen((open) => !open)}
          disabled={clips.length === 0}
        >
          <Download className="editor-transport__icon" aria-hidden="true" focusable="false" />
          <span>Export…</span>
        </button>
        {exportOpen && (
          <div className="final-export__popover" role="dialog" aria-label="Final video export">
            <div className="final-export__header">
              <strong>Final export</strong>
              <button type="button" onClick={() => setExportOpen(false)} aria-label="Close export">
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <label>
              Format
              <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as VideoExportFormat)} disabled={renderJob.job?.status === 'running'}>
                <option value="mp4">MP4 · H.264</option>
                <option value="mov">MOV · ProRes 422 HQ</option>
                <option value="webm">WebM · VP9</option>
                <option value="gif">Animated GIF</option>
              </select>
            </label>
            <label>
              Resolution
              <select value={exportResolution} onChange={(event) => setExportResolution(event.target.value as VideoExportResolution)} disabled={renderJob.job?.status === 'running'}>
                <option value="source">Source</option>
                <option value="1080p">1080p</option>
                <option value="720p">720p</option>
                <option value="480p">480p</option>
              </select>
            </label>
            <label>
              Quality
              <select value={exportQuality} onChange={(event) => setExportQuality(event.target.value as VideoExportQuality)} disabled={renderJob.job?.status === 'running' || exportFormat === 'mov' || exportFormat === 'gif'}>
                <option value="high">High</option>
                <option value="balanced">Balanced</option>
                <option value="small">Smaller file</option>
              </select>
            </label>
            {renderJob.job?.status === 'running' ? (
              <div className="final-export__progress">
                <progress max={1} value={renderJob.job.progress} />
                <span>{Math.round(renderJob.job.progress * 100)}%</span>
                <button type="button" onClick={() => void renderJob.cancel()}>Cancel</button>
              </div>
            ) : renderJob.job?.status === 'complete' && renderJob.job.outputUrl ? (
              <div className="final-export__actions">
                <a className="final-export__download" href={backendAssetUrlSync(renderJob.job.outputUrl)} download>
                  <Download size={14} aria-hidden="true" /> Download {exportFormat.toUpperCase()}
                </a>
                <button type="button" onClick={renderJob.reset}>New export</button>
              </div>
            ) : (
              <button type="button" className="final-export__start" onClick={handleFinalExport}>
                Export {exportFormat.toUpperCase()}
              </button>
            )}
            {(renderJob.error || renderJob.job?.error) && (
              <div className="final-export__error" role="alert">{renderJob.error || renderJob.job?.error}</div>
            )}
            {renderJob.job?.status === 'cancelled' && (
              <div className="final-export__status">Export cancelled.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
