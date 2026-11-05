import { memo, type ComponentType } from 'react';
import type { NodeProps } from '@xyflow/react';
import { NodeCardBoundary } from './NodeCardBoundary';

/** `Card` inside its own NodeCardBoundary: what CANVAS_NODE_TYPES draws. */
export function withNodeCardBoundary(Card: ComponentType<NodeProps>): ComponentType<NodeProps> {
  function BoundedCard(props: NodeProps) {
    return <NodeCardBoundary card={props}><Card {...props} /></NodeCardBoundary>;
  }
  BoundedCard.displayName = `Bounded(${Card.displayName ?? Card.name})`;
  // Memoized as the cards are: React Flow re-renders a node's wrapper often.
  return memo(BoundedCard);
}
