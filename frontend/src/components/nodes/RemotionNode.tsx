import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import type { VideoGraphManifest } from '../../types/video';
import type { NodeData } from '../../types';
import { NodeRunError } from './NodeError';
import { PlaceholderLine } from './PlaceholderLine';
import { pendingAttr } from '../../lib/pendingNodes';

interface RemotionNodeData {
  params?: {
    manifest?: VideoGraphManifest;
  };
}

export function RemotionNode({ id, data, selected }: NodeProps) {
  const enterRemotionEditor = useUIStore((s) => s.enterRemotionEditor);
  const params = (data as RemotionNodeData).params;
  const manifest = params?.manifest;
  // Read through a guard (PR #198 review 3, L4): a damaged manifest still
  // draws its card.
  const layers = (Array.isArray(manifest?.timeline) ? manifest.timeline : [])
    .filter((layer) => Boolean(layer) && typeof layer === 'object');
  const layerCount = layers.length;
  const frame = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const totalFrames = layers.reduce(
    (max, l) => Math.max(max, frame(l.time?.startFrame) + frame(l.time?.durationInFrames)),
    0,
  );

  const summary =
    layerCount === 0
      ? 'no layers yet'
      : `${layerCount} layer${layerCount === 1 ? '' : 's'} · ${totalFrames}f`;

  return (
    <div className={`remotion-node ${selected ? 'remotion-node--selected' : ''}`} data-pending={pendingAttr(data.pending)}>
      <Handle type="target" position={Position.Left} id="sources" />
      <div className="remotion-node__title">▶ Remotion Composition</div>
      <div className="remotion-node__summary">{summary}</div>
      <PlaceholderLine pending={data.pending} />
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
