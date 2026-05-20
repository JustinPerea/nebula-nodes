import { useState } from 'react';
import type { Node } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { renderPreview } from '../../lib/editor/api';
import { type EditClip, totalOutputDuration } from '../../lib/editor/virtualPlayback';
import { formatSmpte } from '../../lib/editor/timecode';

interface Props {
  editNode: Node;
  sourceUrl: string;
}

export function EditorTransport({ editNode, sourceUrl }: Props) {
  const [isRendering, setIsRendering] = useState(false);
  const [hasRendered, setHasRendered] = useState(false);
  const selectedClipId = useUIStore((s) => s.selectedClipId);
  const updateClip = useGraphStore((s) => s.updateEditNodeClip);

  const params = (editNode.data as any).params ?? {};
  const clips: EditClip[] = params.clips ?? [];
  const fps: number = params.sourceFps ?? 30;
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
        <button className="editor-transport__btn editor-transport__btn--primary" type="button">⏵ Play</button>
        <button className="editor-transport__btn" type="button">⏮</button>
        <button className="editor-transport__btn" type="button">⏭</button>
      </div>
      <span className="editor-transport__divider" />
      <div className="editor-transport__group">
        <button className="editor-transport__tool" type="button">✂ Trim</button>
        <button className="editor-transport__tool" type="button">⏩ Speed</button>
        <button className="editor-transport__tool" type="button">⌖ Cut</button>
        <button className="editor-transport__tool" type="button">🔊 Vol</button>
      </div>

      {selectedClip && (
        <div className="editor-transport__inspector">
          <label className="editor-transport__label">Speed</label>
          <input type="range" min={0.25} max={4} step={0.05}
            value={selectedClip.speed}
            onChange={(e) => updateClip(editNode.id, selectedClip.id, { speed: parseFloat(e.target.value) })} />
          <span className="editor-transport__value">{selectedClip.speed.toFixed(2)}×</span>
          <button onClick={() => updateClip(editNode.id, selectedClip.id, { speed: 0.5 })}>0.5×</button>
          <button onClick={() => updateClip(editNode.id, selectedClip.id, { speed: 1.0 })}>1×</button>
          <button onClick={() => updateClip(editNode.id, selectedClip.id, { speed: 2.0 })}>2×</button>

          <label className="editor-transport__label">Vol</label>
          <input type="range" min={0} max={1} step={0.05}
            value={selectedClip.mute ? 0 : selectedClip.volume}
            disabled={selectedClip.mute}
            onChange={(e) => updateClip(editNode.id, selectedClip.id, { volume: parseFloat(e.target.value) })} />
          <span className="editor-transport__value">
            {Math.round((selectedClip.mute ? 0 : selectedClip.volume) * 100)}%
          </span>
          <button
            type="button"
            onClick={() => updateClip(editNode.id, selectedClip.id, { mute: !selectedClip.mute })}
            aria-pressed={selectedClip.mute}
          >
            {selectedClip.mute ? '🔇' : '🔊'}
          </button>
        </div>
      )}

      <span className="editor-transport__summary">
        {clips.length} clip{clips.length === 1 ? '' : 's'} · {formatSmpte(totalDur, fps)}
      </span>
      <button
        type="button"
        className="editor-transport__btn editor-transport__btn--render"
        onClick={handleRender}
        disabled={isRendering || clips.length === 0}
      >
        {isRendering ? 'Rendering…' : hasRendered ? '⟳ Re-render' : '⟳ Render Preview'}
      </button>
    </div>
  );
}
