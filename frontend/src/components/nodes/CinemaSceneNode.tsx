import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { shotPortId } from '../../constants/ports';
import type { CinemaSceneSpec, CinemaShot } from '../../types';
import '../../styles/cinema-node.css';

interface CinemaSceneNodeData {
  params?: {
    scene?: CinemaSceneSpec;
  };
}

export function CinemaSceneNode({ id, data, selected }: NodeProps) {
  const enterCinemaEditor = useUIStore((s) => s.enterCinemaEditor);
  const params = (data as CinemaSceneNodeData).params;
  const scene = params?.scene;
  const shots: CinemaShot[] = scene?.shots ?? [];
  const shotCount = shots.length;

  // Contact-sheet thumbnail: first shot with a finished image, else placeholder.
  const thumbUrl =
    scene?.character?.sheetUrl ??
    shots.find((s) => s.output?.imageUrl)?.output?.imageUrl ??
    null;

  // Uploaded character refs (those wired in on the canvas already show as the
  // edge into character_refs). Surfacing the count keeps the card in sync with
  // refs added inside the Studio.
  const refCount = scene?.character?.refImageUrls?.length ?? 0;
  const summary = [
    shotCount === 0 ? 'no shots yet' : `${shotCount} shot${shotCount === 1 ? '' : 's'}`,
    refCount > 0 ? `${refCount} ref${refCount === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`cinema-scene-node ${selected ? 'cinema-scene-node--selected' : ''}`}>
      {/* Optional shared character refs come in on the left. */}
      <Handle
        type="target"
        position={Position.Left}
        id="character_refs"
        className="cinema-scene-node__handle"
        style={{ backgroundColor: PORT_COLORS.Image }}
      />

      <div className="cinema-scene-node__title">⛭ Cinema Scene</div>

      <div className="cinema-scene-node__thumb">
        {thumbUrl ? (
          <img src={thumbUrl} alt="" className="cinema-scene-node__thumb-img" draggable={false} />
        ) : (
          <div className="cinema-scene-node__thumb-placeholder">storyboard</div>
        )}
      </div>

      <div className="cinema-scene-node__summary">{summary}</div>

      {selected && (
        <button
          type="button"
          className="cinema-scene-node__open nodrag"
          onClick={() => enterCinemaEditor(id)}
        >
          Open Studio
        </button>
      )}

      {/* One source Handle per shot — ids derived from the spec's shots. The
          store keeps node.data.dynamicOutputPorts in lock-step so edges and the
          connection validator resolve these handles. */}
      {shots.length > 0 && (
        <div className="cinema-scene-node__shot-ports">
          {shots.map((shot, idx) => (
            <div key={shot.id} className="cinema-scene-node__shot-port-row">
              <span className="cinema-scene-node__shot-label">
                {idx + 1}
                {shot.output?.status === 'error' ? ' ⚠' : ''}
              </span>
              <Handle
                type="source"
                position={Position.Right}
                id={shotPortId(shot.id)}
                className="cinema-scene-node__handle"
                style={{ backgroundColor: PORT_COLORS.Image }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
