import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { NodeData } from '../../types';
import { NodeRunError } from './NodeError';
import '../../styles/nodes.css';

function RerouteNodeComponent({ data }: NodeProps) {
  return (
    <div className="reroute-node">
      {/* The dot has no body, so its run error (a wire it needs, error copy
          round 3e) hangs below it at a card's width. */}
      <NodeRunError data={data as unknown as NodeData} className="reroute-node__run-error nodrag nowheel" />
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
