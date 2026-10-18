import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { storedAssetId, useStoredAsset } from '../../store/storedAssetsStore';
import { NodeSettingsAction } from './NodeSettingsAction';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { backendAssetUrlSync } from '../../lib/backend';
import '../../styles/character-node.css';

// The node stores only the Character's id (its `character` param, which agents
// set too); the card shows the Character as it is now (storedAssetsStore). The
// canonical asset flows through the graph as a CharacterBundle at execution
// time (handlers/character_node.py).
interface CharacterNodeData {
  params?: Record<string, unknown>;
}

export function CharacterNode({ id, data, selected }: NodeProps) {
  const enterCharacterEditor = useUIStore((s) => s.enterCharacterEditor);
  const characterId = storedAssetId('character', (data as CharacterNodeData).params);
  const entry = useStoredAsset('character', characterId);
  const character = entry?.summary ?? null;
  const status = characterId ? entry?.status ?? 'loading' : 'empty';
  const name = character?.name.trim() || (status === 'missing' ? 'Character not found' : 'Character');
  const thumbUrl = character?.thumbnail ? backendAssetUrlSync(character.thumbnail) : null;

  // Surface the id (short) so an unnamed-but-attached character is still
  // identifiable on the canvas.
  const summary = status === 'empty' ? 'no character attached'
    : status === 'missing' ? `#${characterId} was deleted or never existed`
      : `#${characterId}`;

  return (
    <div className={`character-node ${selected ? 'character-node--selected' : ''}`} data-character-status={status} data-node-inspector-anchor={id}>
      <div className="character-node__title">◐ {name}</div>
      <NodeSettingsAction id={id} />

      <div className="character-node__thumb">
        {thumbUrl ? (
          <img src={thumbUrl} alt="" className="character-node__thumb-img" draggable={false} />
        ) : (
          <div className="character-node__thumb-placeholder">character</div>
        )}
      </div>

      <div className="character-node__summary">{summary}</div>

      {selected && characterId && status !== 'missing' && (
        <button
          type="button"
          className="character-node__open nodrag"
          onClick={() => enterCharacterEditor(characterId)}
        >
          Open Character
        </button>
      )}

      {/* Single Character-typed source handle on the right. */}
      <Handle
        type="source"
        position={Position.Right}
        id="character"
        className="character-node__handle"
        style={{ backgroundColor: PORT_COLORS.Character }}
      />
    </div>
  );
}
