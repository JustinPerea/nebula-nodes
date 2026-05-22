import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
import type { TrackComponentType } from '../../types/video';

interface RemotionEditorToolbarProps {
  remotionNodeId: string;
}

const ADD_BUTTONS: Array<{ label: string; componentType: TrackComponentType }> = [
  { label: '+ Text', componentType: 'TextNode' },
  { label: '+ SVG', componentType: 'SVGInput' },
  { label: '+ Image', componentType: 'ImageAssetNode' },
  { label: '+ Video', componentType: 'VideoAssetNode' },
];

export function RemotionEditorToolbar({ remotionNodeId }: RemotionEditorToolbarProps) {
  const addTrackItemWithCanvasMirror = useGraphStore((s) => s.addTrackItemWithCanvasMirror);
  const deleteTrackItem = useGraphStore((s) => s.deleteTrackItem);
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);

  const handleAdd = (componentType: TrackComponentType) => {
    addTrackItemWithCanvasMirror(remotionNodeId, { componentType });
  };

  const handleDelete = () => {
    if (!selectedTrackItemId) return;
    deleteTrackItem(remotionNodeId, selectedTrackItemId);
  };

  return (
    <div className="remotion-editor-toolbar">
      {ADD_BUTTONS.map((btn) => (
        <button
          key={btn.componentType}
          type="button"
          className="remotion-editor-toolbar__add"
          onClick={() => handleAdd(btn.componentType)}
        >
          {btn.label}
        </button>
      ))}
      <button
        type="button"
        className="remotion-editor-toolbar__delete"
        onClick={handleDelete}
        disabled={!selectedTrackItemId}
      >
        Delete
      </button>
    </div>
  );
}
