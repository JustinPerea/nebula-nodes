import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
import type { TrackItem, VideoGraphManifest } from '../../types/video';

interface RemotionPropertiesPanelProps {
  remotionNodeId: string;
}

export function RemotionPropertiesPanel({ remotionNodeId }: RemotionPropertiesPanelProps) {
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === remotionNodeId));
  const updateTrackItemProps = useGraphStore((s) => s.updateTrackItemProps);
  const updateTrackItemTime = useGraphStore((s) => s.updateTrackItemTime);

  const manifest = ((node?.data.params as { manifest?: VideoGraphManifest } | undefined)?.manifest) ?? null;
  const item: TrackItem | null = manifest?.timeline.find((t) => t.id === selectedTrackItemId) ?? null;

  if (!item) {
    return (
      <aside className="remotion-properties-panel remotion-properties-panel--empty">
        <p>No layer selected</p>
        <p className="remotion-properties-panel__hint">Click a layer in the timeline to edit it.</p>
      </aside>
    );
  }

  const onTimePatch = (patch: Partial<{ startFrame: number; durationInFrames: number }>) => {
    updateTrackItemTime(remotionNodeId, item.id, patch);
  };
  const onPropsPatch = (patch: Record<string, unknown>) => {
    updateTrackItemProps(remotionNodeId, item.id, patch);
  };

  return (
    <aside className="remotion-properties-panel">
      <header className="remotion-properties-panel__header">
        <span className="remotion-properties-panel__type">{item.componentType}</span>
        <span className="remotion-properties-panel__id">{item.id.slice(0, 8)}</span>
      </header>

      <section className="remotion-properties-panel__section">
        <h4>Time</h4>
        <label>
          startFrame
          <input
            type="number"
            value={item.time.startFrame}
            onChange={(e) => onTimePatch({ startFrame: Number(e.target.value) })}
          />
        </label>
        <label>
          durationInFrames
          <input
            type="number"
            min={1}
            value={item.time.durationInFrames}
            onChange={(e) => onTimePatch({ durationInFrames: Number(e.target.value) })}
          />
        </label>
      </section>

      {item.componentType === 'TextNode' && (
        <section className="remotion-properties-panel__section">
          <h4>Text</h4>
          <label>
            text
            <input
              type="text"
              value={(item.props.text as string) ?? ''}
              onChange={(e) => onPropsPatch({ text: e.target.value })}
            />
          </label>
          <label>
            fontSize
            <input
              type="number"
              value={(item.props.fontSize as number) ?? 64}
              onChange={(e) => onPropsPatch({ fontSize: Number(e.target.value) })}
            />
          </label>
          <label>
            color
            <input
              type="color"
              value={(item.props.color as string) ?? '#ffffff'}
              onChange={(e) => onPropsPatch({ color: e.target.value })}
            />
          </label>
        </section>
      )}

      {(item.componentType === 'ImageAssetNode' || item.componentType === 'VideoAssetNode') && (
        <section className="remotion-properties-panel__section">
          <h4>Source</h4>
          <label>
            src (URL)
            <input
              type="text"
              value={(item.props.src as string) ?? ''}
              onChange={(e) => onPropsPatch({ src: e.target.value })}
            />
          </label>
        </section>
      )}

      {item.componentType === 'VideoAssetNode' && (
        <section className="remotion-properties-panel__section">
          <h4>Audio</h4>
          <label>
            volume
            <input
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={(item.props.volume as number) ?? 1}
              onChange={(e) => onPropsPatch({ volume: Number(e.target.value) })}
            />
          </label>
        </section>
      )}

      {item.componentType === 'SVGInput' && (
        <section className="remotion-properties-panel__section">
          <h4>SVG</h4>
          <label>
            inline svg
            <textarea
              rows={6}
              value={(item.props.svg as string) ?? ''}
              onChange={(e) => onPropsPatch({ svg: e.target.value })}
              spellCheck={false}
            />
          </label>
        </section>
      )}
    </aside>
  );
}
