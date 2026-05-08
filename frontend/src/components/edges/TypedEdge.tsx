import { memo } from 'react';
import { BaseEdge, Position, getBezierPath, type EdgeProps } from '@xyflow/react';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { useUIStore } from '../../store/uiStore';
import type { PortDataType } from '../../types';

// React Flow anchors edges at the side edge of the 20px handle box. Slava's
// resting dot sits 4px inward from the handle center, so the visual endpoint
// needs to move 10px to center + 4px to the dot.
const SLAVA_REST_DOT_ENDPOINT_OFFSET = 14;

function getSlavaDotEndpoint(
  x: number,
  y: number,
  position: Position,
): { x: number; y: number } {
  switch (position) {
    case Position.Left:
      return { x: x + SLAVA_REST_DOT_ENDPOINT_OFFSET, y };
    case Position.Right:
      return { x: x - SLAVA_REST_DOT_ENDPOINT_OFFSET, y };
    case Position.Top:
      return { x, y: y + SLAVA_REST_DOT_ENDPOINT_OFFSET };
    case Position.Bottom:
      return { x, y: y - SLAVA_REST_DOT_ENDPOINT_OFFSET };
    default:
      return { x, y };
  }
}

function TypedEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  animated = false,
  data,
}: EdgeProps) {
  const skin = useUIStore((s) => s.skin);
  const dataType = (data?.dataType as PortDataType) ?? 'Any';
  const color = PORT_COLORS[dataType] ?? PORT_COLORS.Any;
  const sourceEndpoint = skin === 'slava-restraint'
    ? getSlavaDotEndpoint(sourceX, sourceY, sourcePosition)
    : { x: sourceX, y: sourceY };
  const targetEndpoint = skin === 'slava-restraint'
    ? getSlavaDotEndpoint(targetX, targetY, targetPosition)
    : { x: targetX, y: targetY };

  const [edgePath] = getBezierPath({
    sourceX: sourceEndpoint.x,
    sourceY: sourceEndpoint.y,
    targetX: targetEndpoint.x,
    targetY: targetEndpoint.y,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        pathLength={100}
        style={{
          stroke: color,
          strokeWidth: selected ? 3 : 2,
          filter: selected ? `drop-shadow(0 0 4px ${color}40)` : undefined,
        }}
      />
      {skin === 'slava-restraint' && animated && (
        <path
          className="typed-edge__pulse"
          d={edgePath}
          pathLength={100}
          fill="none"
          stroke={color}
          aria-hidden="true"
        />
      )}
    </>
  );
}

export const TypedEdge = memo(TypedEdgeComponent);
