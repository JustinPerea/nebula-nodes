import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { storedAssetId, useStoredAsset } from '../../store/storedAssetsStore';
import { NodeSettingsAction } from './NodeSettingsAction';
import { RestoreTrashedAsset } from './RestoreTrashedAsset';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { storedImageView } from '../../lib/storedImage';
import { OutsideImageNote } from '../OutsideImageNote';
import { useOpenOnDoubleClick } from './useOpenOnDoubleClick';
import { NodeRunError } from './NodeError';
import { PlaceholderLine } from './PlaceholderLine';
import { pendingAttr } from '../../lib/pendingNodes';
import type { NodeData } from '../../types';
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
  // Only Nebula's own files are loaded (lib/storedImage.ts).
  const thumb = storedImageView(character?.thumbnail);
  const thumbUrl = thumb.src;

  // Surface the id (short) so an unnamed-but-attached character is still
  // identifiable on the canvas.
  const summary = status === 'empty' ? 'no character attached'
    : status === 'missing' ? `#${characterId} was deleted for good or never existed`
      : status === 'trashed' ? 'In Recently deleted'
        : `#${characterId}`;

  const canOpen = Boolean(characterId) && status !== 'missing' && status !== 'trashed';
  // Double-click opens the Character, as on a Moodboard node (useOpenOnDoubleClick).
  const cardRef = useOpenOnDoubleClick<HTMLDivElement>(canOpen ? () => enterCharacterEditor(characterId) : null);

  return (
    <div ref={cardRef} className={`character-node ${selected ? 'character-node--selected' : ''}`} data-character-status={status} data-pending={pendingAttr(data.pending)}
      data-node-inspector-anchor={id} title={canOpen ? 'Double-click to open in Character Studio' : undefined}>
      <div className="character-node__title">◐ {name}</div>
      <NodeSettingsAction id={id} />

      <div className="character-node__thumb">
        {thumbUrl ? (
          <img src={thumbUrl} alt="" className="character-node__thumb-img" draggable={false} />
        ) : (
          <div className="character-node__thumb-placeholder">{thumb.outside ? <OutsideImageNote /> : 'character'}</div>
        )}
      </div>

      <PlaceholderLine pending={data.pending} />

      <div className="character-node__summary">{summary}</div>

      <NodeRunError data={data as unknown as NodeData} className="character-node__run-error" />

      {status === 'trashed' && (
        <RestoreTrashedAsset kind="character" id={characterId} className="character-node__open" />
      )}

      {selected && canOpen && (
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
