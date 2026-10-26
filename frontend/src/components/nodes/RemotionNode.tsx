import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import type { VideoGraphManifest } from '../../types/video';
import type { NodeData } from '../../types';
import { NodeRunError } from './NodeError';

interface RemotionNodeData {
  params?: {
    manifest?: VideoGraphManifest;
  };
}

export function RemotionNode({ id, data, selected }: NodeProps) {
  const enterRemotionEditor = useUIStore((s) => s.enterRemotionEditor);
  const params = (data as RemotionNodeData).params;
  const manifest = params?.manifest;
  const layers = manifest?.timeline ?? [];
  const layerCount = layers.length;
  const totalFrames = layers.reduce(
    (max, l) => Math.max(max, l.time.startFrame + l.time.durationInFrames),
    0,
  );

  const summary =
    layerCount === 0
      ? 'no layers yet'
      : `${layerCount} layer${layerCount === 1 ? '' : 's'} · ${totalFrames}f`;

  return (
    <div className={`remotion-node ${selected ? 'remotion-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} id="sources" />
      <div className="remotion-node__title">▶ Remotion Composition</div>
      <div className="remotion-node__summary">{summary}</div>
      {selected && (
        <button
          type="button"
          className="remotion-node__open"
          onClick={() => enterRemotionEditor(id)}
        >
          Open Editor
        </button>
      )}
      <NodeRunError data={data as unknown as NodeData} className="remotion-node__run-error" />
      <Handle type="source" position={Position.Right} id="video" />
    </div>
  );
}
