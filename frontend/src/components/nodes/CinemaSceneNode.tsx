import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { SceneUnsavedMark } from './SceneUnsavedMark';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { CATEGORY_COLORS, shotPortId } from '../../constants/ports';
import { missingKeyTitle } from '../../lib/nodeKeys';
import type { NodeData } from '../../types';
import { sceneCardView } from '../../lib/cinemaScene';
import { NodeRunError } from './NodeError';
import { PlaceholderLine } from './PlaceholderLine';
import { pendingAttr } from '../../lib/pendingNodes';
import '../../styles/cinema-node.css';

interface CinemaSceneNodeData {
  params?: {
    scene?: unknown;
  };
  /** Set by the store (kreaConnection.nodeKeyStatus) from the scene's base model. */
  keyStatus?: 'ok' | 'missing';
}

/** The scene's category colour (CATEGORY_COLORS, as every model card reads it). */
const SCENE_CATEGORY_COLOR = CATEGORY_COLORS[NODE_DEFINITIONS['cinema-scene'].category] ?? '#424242';

export function CinemaSceneNode({ id, data, selected }: NodeProps) {
  const enterCinemaEditor = useUIStore((s) => s.enterCinemaEditor);
  // Edits on screen that the backend didn't take (GM, PR #198 r6 item 1):
  // the line that said why, kept as the mark's title.
  const unsaved = useGraphStore((s) => s.unsavedScenes[id] ?? null);
  const stopped = useGraphStore((s) => s.stoppedScenes[id] === true);
  const { params, keyStatus } = data as CinemaSceneNodeData;
  // Read through a guard (PR #198 review 3, L4): a scene whose data is
  // damaged still draws its card.
  const { shots, sheetUrl, refCount } = sceneCardView(params?.scene);
  const shotCount = shots.length;
  const inputPorts = NODE_DEFINITIONS['cinema-scene'].inputPorts;

  // Contact-sheet thumbnail: first shot with a finished image, else placeholder.
  const thumbUrl = sheetUrl ?? shots.find((s) => s.imageUrl)?.imageUrl ?? null;

  // Uploaded character refs (those wired in on the canvas already show as the
  // edge into character_refs). Surfacing the count keeps the card in sync with
  // refs added inside the Studio.
  const summary = [
    shotCount === 0 ? 'no shots yet' : `${shotCount} shot${shotCount === 1 ? '' : 's'}`,
    refCount > 0 ? `${refCount} ref${refCount === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    // GM r7 item 2: one selection style. The card carries its category's
    // colour as ModelNode does, and cinema-node.css selects it in that colour.
    <div className={`cinema-scene-node ${selected ? 'cinema-scene-node--selected' : ''}`} data-pending={pendingAttr(data.pending)}
      style={{ ['--node-category-color' as string]: SCENE_CATEGORY_COLOR }}>
      <div className="cinema-scene-node__title">
        <span className="cinema-scene-node__name">⛭ Cinema Scene</span>
        {keyStatus === 'missing' && (
          <span className="model-node__badge model-node__badge--warning cinema-scene-node__badge"
            title={missingKeyTitle(NODE_DEFINITIONS['cinema-scene'], (params ?? {}) as Record<string, unknown>)}>&#x26A0;</span>
        )}
      </div>
      {/* GM r9: "Unsaved", under the header so it never wraps the title; its
          tooltip is the sentence of the toast that said why. Stopped, a
          click opens that line with [Try again] (GM r12 item 1). */}
      {unsaved && (
        <div className="cinema-scene-node__unsaved-row">
          <SceneUnsavedMark nodeId={id} line={unsaved} stopped={stopped} />
        </div>
      )}

      <div className="cinema-scene-node__thumb">
        {thumbUrl ? (
          <img src={thumbUrl} alt="" className="cinema-scene-node__thumb-img" draggable={false} />
        ) : (
          <div className="cinema-scene-node__thumb-placeholder">storyboard</div>
        )}
      </div>

      <PlaceholderLine pending={data.pending} />

      <div className="cinema-scene-node__summary">{summary}</div>

      {/* The scene node's own run error (error copy round 3e); each shot's
          shows in its panel and as the ⚠ beside its port. */}
      <NodeRunError data={data as unknown as NodeData} className="cinema-scene-node__run-error" />

      <div className="cinema-scene-node__input-ports">
        {inputPorts.map((port) => (
          <div key={port.id} className="cinema-scene-node__input-port-row">
            <Handle
              type="target"
              position={Position.Left}
              id={port.id}
              aria-label={`${port.label} input`}
              className="cinema-scene-node__handle"
              style={{ backgroundColor: PORT_COLORS[port.dataType] }}
            />
            <span className="cinema-scene-node__input-label">{port.label}</span>
          </div>
        ))}
      </div>

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
                {shot.failed ? ' ⚠' : ''}
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
