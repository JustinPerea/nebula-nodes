import { useState } from 'react';
import type { Node } from '@xyflow/react';
import {
  Gauge,
  Play,
  RotateCw,
  Scissors,
  SkipBack,
  SkipForward,
  Split,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { renderPreview } from '../../lib/editor/api';
import { type EditClip, totalOutputDuration, clipSpeed } from '../../lib/editor/virtualPlayback';
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
  const selectedClipId = useUIStore((s) => s.selectedClipId);
  const timelineZoom = useUIStore((s) => s.timelineZoom);
  const updateClip = useGraphStore((s) => s.updateEditNodeClip);

  const params = editNode.data.params;
  const clips = Array.isArray(params.clips) ? (params.clips as EditClip[]) : EMPTY_CLIPS;
  const fps = typeof params.sourceFps === 'number' ? params.sourceFps : 30;
  const totalDur = totalOutputDuration(clips);
  const selectedClip = clips.find((c) => c.id === selectedClipId);

  async function handleRender() {
    setIsRendering(true);
    try {
      await renderPreview({ sourceUrl, clips });
      setHasRendered(true);
    } catch (err) {
      console.error(err);
    } finally {
      setIsRendering(false);
    }
  }

  return (
    <div className="editor-transport">
      <div className="editor-transport__group">
        <button className="editor-transport__btn editor-transport__btn--primary" type="button">
          <Play className="editor-transport__icon" aria-hidden="true" focusable="false" />
          <span>Play</span>
        </button>
        <button className="editor-transport__btn editor-transport__btn--icon" type="button" aria-label="Previous edit point">
          <SkipBack className="editor-transport__icon" aria-hidden="true" focusable="false" />
        </button>
        <button className="editor-transport__btn editor-transport__btn--icon" type="button" aria-label="Next edit point">
          <SkipForward className="editor-transport__icon" aria-hidden="true" focusable="false" />
        </button>
      </div>
      <span className="editor-transport__divider" />
      <div className="editor-transport__group">
        <button className="editor-transport__tool" type="button">
          <Scissors className="editor-transport__icon" aria-hidden="true" focusable="false" />
          <span>Trim</span>
        </button>
        <button className="editor-transport__tool" type="button">
          <Gauge className="editor-transport__icon" aria-hidden="true" focusable="false" />
          <span>Speed</span>
        </button>
        <button className="editor-transport__tool" type="button">
          <Split className="editor-transport__icon" aria-hidden="true" focusable="false" />
          <span>Cut</span>
        </button>
        <button className="editor-transport__tool" type="button">
          <Volume2 className="editor-transport__icon" aria-hidden="true" focusable="false" />
          <span>Vol</span>
        </button>
      </div>

      {selectedClip && (
        <div className="editor-transport__inspector">
          <label className="editor-transport__label">Speed</label>
          <input className="editor-transport__range" type="range" min={0.25} max={4} step={0.05}
            value={clipSpeed(selectedClip)}
            onChange={(e) => {
              const newSpeed = parseFloat(e.target.value);
              if (newSpeed <= 0) return;
              const newDuration = (selectedClip.sourceOut - selectedClip.sourceIn) / newSpeed;
              updateClip(editNode.id, selectedClip.id, { duration: newDuration });
            }} />
          <span className="editor-transport__value">{clipSpeed(selectedClip).toFixed(2)}×</span>
          <button className="editor-transport__preset" type="button" onClick={() => updateClip(editNode.id, selectedClip.id, { duration: (selectedClip.sourceOut - selectedClip.sourceIn) / 0.5 })}>0.5×</button>
          <button className="editor-transport__preset" type="button" onClick={() => updateClip(editNode.id, selectedClip.id, { duration: (selectedClip.sourceOut - selectedClip.sourceIn) })}>1×</button>
          <button className="editor-transport__preset" type="button" onClick={() => updateClip(editNode.id, selectedClip.id, { duration: (selectedClip.sourceOut - selectedClip.sourceIn) / 2 })}>2×</button>

          <label className="editor-transport__label">Vol</label>
          <input className="editor-transport__range" type="range" min={0} max={1} step={0.05}
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
    </div>
  );
}
