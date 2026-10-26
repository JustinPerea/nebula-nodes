import type { CSSProperties } from 'react';
import { cleanPending, placeholderLine } from '../../lib/pendingNodes';

/**
 * An agent's placeholder (Q125 item 3): the line in the card's preview area
 * (GM - Design, 2026-10-25: "Codex is setting this up."), on every card kind
 * that has a body (GM: "on EVERY node type"; tests/placeholderEveryNode
 * renders each type the canvas draws). A Reroute has no body: its line hangs
 * below the dot, as its run error does. The card dims only its preview while
 * the node is pending (nodes.css, `data-pending` from lib/pendingNodes `pendingAttr`); the
 * dashed outline in the agent's colour is AgentNodeMarkLayer's.
 */
export function PlaceholderLine({ pending, className }: { pending: unknown; className?: string }) {
  const flag = cleanPending(pending);
  if (!flag) return null;
  return (
    <div className={className ? `model-node__pending ${className}` : 'model-node__pending'}
      style={{ '--pending-color': flag.agent.color } as CSSProperties}>
      {placeholderLine(flag.agent.name)}
    </div>
  );
}

