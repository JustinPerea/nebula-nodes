import { memo, type ComponentType } from 'react';
import type { NodeProps } from '@xyflow/react';
import { NodeCardBoundary } from './NodeCardBoundary';
import { NodeWaitBand } from './NodeWaitBand';

/** `Card` inside its own NodeCardBoundary: what CANVAS_NODE_TYPES draws.
 * Above it, inside the node's box, the band a run held by the daily total
 * shows while it waits (NodeWaitBand: nothing otherwise). */
export function withNodeCardBoundary(Card: ComponentType<NodeProps>): ComponentType<NodeProps> {
  function BoundedCard(props: NodeProps) {
    return (
      <>
        <NodeWaitBand nodeId={props.id} />
        <NodeCardBoundary card={props}><Card {...props} /></NodeCardBoundary>
      </>
    );
  }
  BoundedCard.displayName = `Bounded(${Card.displayName ?? Card.name})`;
  // Memoized as the cards are: React Flow re-renders a node's wrapper often.
  return memo(BoundedCard);
}
