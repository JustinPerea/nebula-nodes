import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { backendAssetUrlSync } from '../../lib/backend';
import '../../styles/moodboard-node.css';

interface MoodboardNodeData {
  params?: {
    _moodboardId?: string;
    _moodboardName?: string;
    _moodboardThumbnail?: string;
    _moodboardImageCount?: number;
    _moodboardMode?: string;
  };
}

const OUTPUTS = [
  { id: 'moodboard', label: 'Moodboard', color: PORT_COLORS.Moodboard },
  { id: 'style_brief', label: 'Brief', color: PORT_COLORS.Text },
  { id: 'negative_prompt', label: 'Negative', color: PORT_COLORS.Text },
  { id: 'representative_images', label: 'Images', color: PORT_COLORS.Array },
  { id: 'palette', label: 'Palette', color: PORT_COLORS.Array },
];

export function MoodboardNode({ data, selected }: NodeProps) {
  const enterMoodboardEditor = useUIStore((s) => s.enterMoodboardEditor);
  const params = (data as MoodboardNodeData).params ?? {};
  const id = params._moodboardId ?? '';
  const name = params._moodboardName?.trim() || 'Moodboard';
  const thumbnail = params._moodboardThumbnail || '';
  const imageCount = Number(params._moodboardImageCount ?? 0);
  const mode = params._moodboardMode || 'look';

  return (
    <div className={`moodboard-node ${selected ? 'moodboard-node--selected' : ''}`}>
      <div className="moodboard-node__title">Moodboard</div>
      <div className="moodboard-node__name">{name}</div>
      <div className="moodboard-node__preview">
        {thumbnail ? (
          <img src={backendAssetUrlSync(thumbnail)} alt="" draggable={false} />
        ) : (
          <span>No images</span>
        )}
      </div>
      <div className="moodboard-node__meta">{imageCount} images · {mode}</div>
      {selected && id && (
        <button
          type="button"
          className="moodboard-node__open nodrag"
          onClick={() => enterMoodboardEditor(id)}
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
