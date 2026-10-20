import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { storedAssetId, useStoredAsset } from '../../store/storedAssetsStore';
import { NodeSettingsAction } from './NodeSettingsAction';
import { RestoreTrashedAsset } from './RestoreTrashedAsset';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { backendAssetUrlSync } from '../../lib/backend';
import { useOpenOnDoubleClick } from './useOpenOnDoubleClick';
import { moodboardImagesLabel } from '../../lib/moodboardCount';
import '../../styles/moodboard-node.css';

// The node stores only the board's id (its `moodboard` param, which agents
// set too); the card shows the board as it is now (storedAssetsStore).
interface MoodboardNodeData {
  params?: Record<string, unknown>;
}

const OUTPUTS = [
  { id: 'moodboard', label: 'Moodboard', color: PORT_COLORS.Moodboard },
  { id: 'style_brief', label: 'Brief', color: PORT_COLORS.Text },
  { id: 'negative_prompt', label: 'Negative', color: PORT_COLORS.Text },
  { id: 'representative_images', label: 'Images', color: PORT_COLORS.Array },
  { id: 'palette', label: 'Palette', color: PORT_COLORS.Array },
];

export function MoodboardNode({ id, data, selected }: NodeProps) {
  const enterMoodboardEditor = useUIStore((s) => s.enterMoodboardEditor);
  const boardId = storedAssetId('moodboard', (data as MoodboardNodeData).params);
  const entry = useStoredAsset('moodboard', boardId);
  const board = entry?.summary ?? null;
  const status = boardId ? entry?.status ?? 'loading' : 'empty';

  const name = board?.name.trim()
    || (status === 'empty' ? 'No board chosen' : status === 'missing' ? 'Board not found' : 'Moodboard');
  const meta = board
    ? `${moodboardImagesLabel(board.imageCount ?? 0, board.setAsideCount)} · ${board.mode ?? 'look'}`
    : status === 'empty' ? 'Choose one in the Inspector'
      : status === 'missing' ? `#${boardId} was deleted for good or never existed`
        : status === 'error' ? "Couldn't load this board" : 'Loading…';
  // A board in Recently deleted keeps its name and picture here, with Restore.
  const trashed = status === 'trashed';
  const canOpen = Boolean(boardId) && status !== 'missing' && !trashed;
  // Double-click opens the board, selected or not, at any zoom; the Open
  // button below shows while the node is selected.
  const cardRef = useOpenOnDoubleClick<HTMLDivElement>(canOpen ? () => enterMoodboardEditor(boardId) : null);

  return (
    <div ref={cardRef} className={`moodboard-node ${selected ? 'moodboard-node--selected' : ''}`} data-moodboard-status={status}
      data-node-inspector-anchor={id} title={canOpen ? 'Double-click to open in Moodboard Studio' : undefined}>
      <div className="moodboard-node__title">Moodboard</div>
      <NodeSettingsAction id={id} />
      <div className="moodboard-node__name">{name}</div>
      <div className="moodboard-node__preview">
        {board?.thumbnail ? (
          <img src={backendAssetUrlSync(board.thumbnail)} alt="" draggable={false} />
        ) : (
          <span>No images</span>
        )}
      </div>
      <div className="moodboard-node__meta">{trashed ? 'In Recently deleted' : meta}</div>
      {trashed && <RestoreTrashedAsset kind="moodboard" id={boardId} className="moodboard-node__open" />}
      {selected && canOpen && (
        <button
          type="button"
          className="moodboard-node__open nodrag"
          onClick={() => enterMoodboardEditor(boardId)}
        >
          Open Moodboard
        </button>
      )}
      {OUTPUTS.map((output, index) => (
        <div
          key={output.id}
          className="moodboard-node__output"
          style={{ top: 66 + index * 24 }}
        >
          <span>{output.label}</span>
          <Handle
            type="source"
            position={Position.Right}
            id={output.id}
            className="moodboard-node__handle"
            style={{ backgroundColor: output.color }}
          />
        </div>
      ))}
    </div>
  );
}
