import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeData } from '../../types';
import { NodeRunError } from './NodeError';
import { PlaceholderLine } from './PlaceholderLine';
import { pendingAttr } from '../../lib/pendingNodes';
import '../../styles/nodes.css';

function RerouteNodeComponent({ data }: NodeProps) {
  return (
    <div className="reroute-node" data-pending={pendingAttr(data.pending)}>
      {/* The dot has no body, so its run error (a wire it needs, error copy
          round 3e) hangs below it at a card's width, and so does whose
          placeholder it is (Q125 item 3). */}
      <NodeRunError data={data as unknown as NodeData} className="reroute-node__run-error nodrag nowheel" />
      <PlaceholderLine pending={data.pending} className="reroute-node__pending" />
      <Handle
        type="target"
        position={Position.Left}
        id="input"
        className="reroute-node__handle"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        className="reroute-node__handle"
      />
    </div>
  );
}

export const RerouteNode = memo(RerouteNodeComponent);
