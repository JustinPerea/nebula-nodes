import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
import type { TrackItem, VideoGraphManifest } from '../../types/video';
import { SpatialAxisInput } from './SpatialAxisInput';

function isVoxelCellArray(
  v: unknown,
): v is Array<{ x: number; y: number; z: number; color?: string }> {
  if (!Array.isArray(v)) return false;
  return v.every(
    (cell) =>
      typeof cell === 'object' &&
      cell !== null &&
      typeof (cell as Record<string, unknown>).x === 'number' &&
      typeof (cell as Record<string, unknown>).y === 'number' &&
      typeof (cell as Record<string, unknown>).z === 'number',
  );
}

interface RemotionPropertiesPanelProps {
  remotionNodeId: string;
}

export function RemotionPropertiesPanel({ remotionNodeId }: RemotionPropertiesPanelProps) {
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === remotionNodeId));
  const updateTrackItemProps = useGraphStore((s) => s.updateTrackItemProps);
  const updateTrackItemTime = useGraphStore((s) => s.updateTrackItemTime);
  const updateTrackItemSpatial = useGraphStore((s) => s.updateTrackItemSpatial);

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
  const onSpatialPatch = (patch: Partial<TrackItem['spatial']>) => {
    updateTrackItemSpatial(remotionNodeId, item.id, patch);
  };
  const onScaleValue = (index: 0 | 1 | 2, value: number) => {
    const nextScale: TrackItem['spatial']['scale'] = [
      item.spatial.scale[0],
      item.spatial.scale[1],
      item.spatial.scale[2],
    ];
    nextScale[index] = value;
    onSpatialPatch({ scale: nextScale });
  };
  const onRotationValue = (index: 0 | 1 | 2, value: number) => {
    const nextRotation: TrackItem['spatial']['rotation'] = [
      item.spatial.rotation[0],
      item.spatial.rotation[1],
      item.spatial.rotation[2],
    ];
    nextRotation[index] = value;
    onSpatialPatch({ rotation: nextRotation });
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

      <section className="remotion-properties-panel__section">
        <h4>Transform</h4>
        <SpatialAxisInput
          axis="x"
          label="Position X"
          value={item.spatial.x}
          onValueChange={(value) => onSpatialPatch({ x: value })}
        />
        <SpatialAxisInput
          axis="y"
          label="Position Y"
          value={item.spatial.y}
          onValueChange={(value) => onSpatialPatch({ y: value })}
        />
        <SpatialAxisInput
          axis="z"
          label="Position Z"
          value={item.spatial.z}
          onValueChange={(value) => onSpatialPatch({ z: value })}
        />
        <SpatialAxisInput
          axis="x"
          label="Scale X"
          value={item.spatial.scale[0]}
          onValueChange={(value) => onScaleValue(0, value)}
        />
        <SpatialAxisInput
          axis="y"
          label="Scale Y"
          value={item.spatial.scale[1]}
          onValueChange={(value) => onScaleValue(1, value)}
        />
        <SpatialAxisInput
          axis="z"
          label="Scale Z"
          value={item.spatial.scale[2]}
          onValueChange={(value) => onScaleValue(2, value)}
        />
        <SpatialAxisInput
          axis="x"
          label="Rotation X"
          value={item.spatial.rotation[0]}
          onValueChange={(value) => onRotationValue(0, value)}
        />
        <SpatialAxisInput
          axis="y"
          label="Rotation Y"
          value={item.spatial.rotation[1]}
          onValueChange={(value) => onRotationValue(1, value)}
        />
        <SpatialAxisInput
          axis="z"
          label="Rotation Z"
          value={item.spatial.rotation[2]}
          onValueChange={(value) => onRotationValue(2, value)}
        />
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

      {item.componentType === 'IsometricBlock' && (
        <section className="remotion-properties-panel__section">
          <h4>Iso Block</h4>
          <label>
            geometry
            <select
              value={(item.props.geometry as string) ?? 'cube'}
              onChange={(e) => onPropsPatch({ geometry: e.target.value })}
            >
              <option value="cube">Cube</option>
              <option value="sphere">Sphere</option>
              <option value="cylinder">Cylinder</option>
              <option value="cone">Cone</option>
              <option value="plane">Plane</option>
              <option value="gltf">GLTF</option>
              <option value="voxel">Voxel</option>
            </select>
          </label>
          <label>
            color
            <input
              type="color"
              value={(item.props.color as string) ?? '#888888'}
              onChange={(e) => onPropsPatch({ color: e.target.value })}
            />
          </label>
          <label>
            size
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={(item.props.size as number) ?? 1}
              onChange={(e) => onPropsPatch({ size: Number(e.target.value) })}
            />
          </label>
          {item.props.geometry === 'gltf' && (
            <label>
              gltfUrl
              <input
                type="text"
                value={(item.props.gltfUrl as string) ?? ''}
                onChange={(e) => onPropsPatch({ gltfUrl: e.target.value })}
              />
            </label>
          )}
          {item.props.geometry === 'voxel' && (
            <label>
              voxels (JSON array)
              <textarea
                rows={6}
                spellCheck={false}
                value={JSON.stringify(item.props.voxels ?? [], null, 0)}
                onChange={(e) => {
                  try {
                    const parsed = JSON.parse(e.target.value);
                    if (isVoxelCellArray(parsed)) {
                      onPropsPatch({ voxels: parsed });
                    }
                  } catch {
                    // ignore invalid JSON or wrong shape — user is mid-edit
                  }
                }}
              />
            </label>
          )}
        </section>
      )}

      {item.componentType === 'LottieNode' && (
        <section className="remotion-properties-panel__section">
          <h4>Lottie</h4>
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
    </aside>
  );
}
