import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { PORT_COLORS } from '../../lib/portCompatibility';
import '../../styles/character-node.css';

// The CharacterNode renders entirely from the React Flow node `data` it already
// receives — it does NOT fetch the Character over the network. The canonical
// asset lives in the backend CharacterStore and flows through the graph as a
// CharacterBundle at execution time (handlers/character_node.py). For the
// canvas card we only need the denormalized fields that Task 5/6's
// addCharacterNode / library populate onto params:
//   - characterId    (always present once a Character is attached)
//   - characterName   (denormalized display name; optional)
//   - characterThumbnail (denormalized thumbnail URL; optional)
// Missing fields fall back to neutral placeholders so the node always renders.
interface CharacterNodeData {
  params?: {
    characterId?: string;
    characterName?: string;
    characterThumbnail?: string;
  };
}

export function CharacterNode({ data, selected }: NodeProps) {
  const enterCharacterEditor = useUIStore((s) => s.enterCharacterEditor);
  const params = (data as CharacterNodeData).params ?? {};
  const characterId = params.characterId ?? '';
  const name = params.characterName?.trim() || 'Character';
  const thumbUrl = params.characterThumbnail || null;

  // Surface the id (short) so an unnamed-but-attached character is still
  // identifiable on the canvas; empty when no character is attached yet.
  const summary = characterId ? `#${characterId}` : 'no character attached';

  return (
    <div className={`character-node ${selected ? 'character-node--selected' : ''}`}>
      <div className="character-node__title">◐ {name}</div>

      <div className="character-node__thumb">
        {thumbUrl ? (
          <img src={thumbUrl} alt="" className="character-node__thumb-img" draggable={false} />
        ) : (
          <div className="character-node__thumb-placeholder">character</div>
        )}
      </div>

      <div className="character-node__summary">{summary}</div>

      {selected && characterId && (
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
