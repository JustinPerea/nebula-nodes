import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import '../../styles/nodes.css';

function RerouteNodeComponent() {
  return (
    <div className="reroute-node">
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
