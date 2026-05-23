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
  { label: '+ Iso Block', componentType: 'IsometricBlock' },
  { label: '+ Lottie', componentType: 'LottieNode' },
];

export function RemotionEditorToolbar({ remotionNodeId }: RemotionEditorToolbarProps) {
  const addTrackItemWithCanvasMirror = useGraphStore((s) => s.addTrackItemWithCanvasMirror);
  const deleteTrackItem = useGraphStore((s) => s.deleteTrackItem);
  const selectedTrackItemId = useUIStore((s) => s.selectedTrackItemId);
  const setSelectedTrackItem = useUIStore((s) => s.setSelectedTrackItem);
  const isKeyframeRecording = useUIStore((s) => s.isKeyframeRecording);
  const toggleKeyframeRecording = useUIStore((s) => s.toggleKeyframeRecording);

  const handleAdd = (componentType: TrackComponentType) => {
    addTrackItemWithCanvasMirror(remotionNodeId, { componentType });
  };

  const handleDelete = () => {
    if (!selectedTrackItemId) return;
    deleteTrackItem(remotionNodeId, selectedTrackItemId);
    setSelectedTrackItem(null);
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
      <button
        type="button"
        className={`remotion-editor-toolbar__record ${isKeyframeRecording ? 'remotion-editor-toolbar__record--active' : ''}`}
        onClick={toggleKeyframeRecording}
        title={isKeyframeRecording ? 'Recording keyframes - click to stop' : 'Click to record keyframes on drag'}
      >
        ● REC
      </button>
    </div>
  );
}
