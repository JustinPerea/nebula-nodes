import { memo } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import { PORT_COLORS } from '../../lib/portCompatibility';
import type { PortDataType } from '../../types';

function TypedEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps) {
  const dataType = (data?.dataType as PortDataType) ?? 'Any';
  const color = PORT_COLORS[dataType] ?? PORT_COLORS.Any;

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: color,
        strokeWidth: selected ? 3 : 2,
        filter: selected ? `drop-shadow(0 0 4px ${color}40)` : undefined,
      }}
    />
  );
}

export const TypedEdge = memo(TypedEdgeComponent);
